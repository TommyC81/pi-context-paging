import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export type ToolRecoveryReference = {
	historyId: string;
	toolCallId: string;
	toolName: string;
};

/** Only recoverable provenance gives an entry a history ID and an exact read handle. */
export type ConversationProvenance = { recoveryHistoryId(message: AgentMessage): string | undefined };

const RECENT_REPLY_TURNS = 3;
const ENTRY_CHARACTERS = 6_000;
const SECTION_CHARACTERS = 32_000;
const MINIMUM_CLIPPED_CHARACTERS = 500;

type ConversationEntry = { kind: "user message" | "assistant reply"; historyId: string; text: string; part: string };
/** An entry from turn number `turn`, with its whole block formatted on first use. */
type RecordedEntry = { entry: ConversationEntry; turn: number; whole?: string };

function requestEntry(message: UserMessage, historyId: string): ConversationEntry | undefined {
	const text = typeof message.content === "string"
		? message.content
		: message.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n");
	return text.trim() === "" ? undefined : { kind: "user message", historyId, text, part: "/userMessage/content" };
}

function replyEntry(message: AssistantMessage, historyId: string): ConversationEntry | undefined {
	const indexes = message.content.flatMap((block, index) => block.type === "text" && block.text.trim() !== "" ? [index] : []);
	if (indexes.length === 0) return undefined;
	const text = indexes.map((index) => (message.content[index] as { text: string }).text).join("\n");
	const part = indexes.length === 1 ? `/assistantMessage/content/${indexes[0]}` : "/assistantMessage/content";
	return { kind: "assistant reply", historyId, text, part };
}

function lastPublicReply(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index > 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.trim() !== "")) return message;
	}
	return undefined;
}

function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = /[\uD800-\uDBFF]/u.test(text[limit - 1] ?? "") ? limit - 1 : limit;
	return text.slice(0, end);
}

function entryHeader(entry: ConversationEntry): string {
	return `--- ${entry.kind}, historyId ${JSON.stringify(entry.historyId)} ---`;
}

function clipMarker(entry: ConversationEntry, shown: number): string {
	const handle = JSON.stringify({ historyId: entry.historyId, part: entry.part });
	return `[Clipped after ${shown.toLocaleString("en-US")} of ${entry.text.length.toLocaleString("en-US")} characters. `
		+ `Read the full text with read_context_output(${handle}).]`;
}

function formatEntry(entry: ConversationEntry, limit: number): string {
	const text = clipText(entry.text, limit);
	const lines = [entryHeader(entry), text];
	if (text.length < entry.text.length) lines.push(clipMarker(entry, text.length));
	return lines.join("\n");
}

/** The largest clipped block that fits the room, or undefined when too little text would remain. */
function clippedEntry(entry: ConversationEntry, room: number): string | undefined {
	const overhead = entryHeader(entry).length + clipMarker(entry, ENTRY_CHARACTERS).length + 2;
	const limit = Math.min(ENTRY_CHARACTERS, room - overhead);
	return limit >= MINIMUM_CLIPPED_CHARACTERS ? formatEntry(entry, limit) : undefined;
}

const SECTION_HEADING = "Earlier conversation, copied from session history, oldest first. These messages were already handled. They are not new requests, but they may still define the current task.";

function omittedLine(omitted: number, oldestShownId: string | undefined): string {
	const count = omitted === 1 ? "1 earlier user message is" : `${omitted} earlier user messages are`;
	return oldestShownId !== undefined
		? `${count} not shown. Find them with browse_history(${JSON.stringify({ historyId: oldestShownId, direction: "backward" })}).`
		: `${count} not shown. Find them with search_history or browse_history.`;
}

/**
 * Copied requests and closing replies of fully evicted turns, oldest first.
 * Rendering walks back only until the section is full, so its work stays bounded however many turns were evicted.
 */
export class EvictedConversation {
	private readonly requests: RecordedEntry[] = [];
	/** Replies of the newest RECENT_REPLY_TURNS turns only. */
	private readonly replies: RecordedEntry[] = [];
	private readonly history: ConversationProvenance;
	private turnCount = 0;
	private longestId = "";

	constructor(history: ConversationProvenance) {
		this.history = history;
	}

	/** Records one fully evicted turn and reports whether it adds notice content. */
	addTurn(messages: readonly AgentMessage[]): boolean {
		const turn = this.turnCount++;
		const first = messages[0];
		const requestId = first?.role === "user" ? this.history.recoveryHistoryId(first) : undefined;
		const request = first?.role === "user" && requestId !== undefined ? requestEntry(first, requestId) : undefined;
		const lastReply = lastPublicReply(messages);
		const replyId = lastReply ? this.history.recoveryHistoryId(lastReply) : undefined;
		const reply = lastReply && replyId !== undefined ? replyEntry(lastReply, replyId) : undefined;
		if (request) this.requests.push({ entry: request, turn });
		if (reply) this.replies.push({ entry: reply, turn });
		while (this.replies[0] && this.replies[0].turn < this.turnCount - RECENT_REPLY_TURNS) this.replies.shift();
		for (const entry of [request, reply]) {
			if (entry && entry.historyId.length > this.longestId.length) this.longestId = entry.historyId;
		}
		return request !== undefined || reply !== undefined;
	}

	/** Recorded entries newest first; a reply follows its own turn's request. */
	private *newestFirst(): Generator<RecordedEntry> {
		let request = this.requests.length - 1;
		let reply = this.replies.length - 1;
		while (request >= 0 || reply >= 0) {
			const replyIsNewer = reply >= 0 && (request < 0 || this.replies[reply]!.turn >= this.requests[request]!.turn);
			yield replyIsNewer ? this.replies[reply--]! : this.requests[request--]!;
		}
	}

	/** Chooses entries newest first so the whole section fits the cap, then shows them oldest first. */
	sectionLines(maxCharacters: number): string[] {
		// Reserve the heading, the longest omitted-count line, and the line breaks between them.
		const blocks: string[] = [];
		let room = maxCharacters - SECTION_HEADING.length - omittedLine(this.requests.length, this.longestId).length - 5;
		let shownRequests = 0;
		let oldestShown: ConversationEntry | undefined;
		for (const recorded of this.newestFirst()) {
			const whole = recorded.whole ??= formatEntry(recorded.entry, ENTRY_CHARACTERS);
			const block = whole.length <= room ? whole : clippedEntry(recorded.entry, room);
			if (block === undefined) break;
			blocks.push(block);
			room -= block.length + 2;
			oldestShown = recorded.entry;
			if (recorded.entry.kind === "user message") shownRequests++;
			if (block !== whole) break;
		}
		if (blocks.length === 0) return [];
		const omitted = this.requests.length - shownRequests;
		const lines = ["", SECTION_HEADING];
		if (omitted > 0) lines.push(omittedLine(omitted, oldestShown?.historyId));
		lines.push("", blocks.reverse().join("\n\n"));
		return lines;
	}
}

function temporaryUserMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

/** At most 10% of the effective budget, at about 4 characters per token. */
function conversationCharacterLimit(budgetTokens: number): number {
	return Math.min(SECTION_CHARACTERS, Math.floor(budgetTokens * 0.4));
}

function noticeHeader(
	budgetTokens: number,
	historyId: string | undefined,
	toolReference: ToolRecoveryReference | undefined,
	withConversation: boolean,
): string[] {
	const lines = [
		"[Context paging notice — generated by the extension]",
		"This is context paging, not compaction. Nothing was summarized.",
		`Older context left the ${budgetTokens.toLocaleString("en-US")}-token rolling window. Raw session history is unchanged.`,
		"Continue the current task. Do not stop or ask the user for direction because of this notice.",
		withConversation
			? "To recover detail, first use the earlier conversation below, then plan or notes files, then search_history or browse_history."
			: "To recover detail, first use plan or notes files, then search_history or browse_history.",
		"Use load_history for exact items or read_context_output for exact output pages.",
	];
	if (historyId !== undefined) lines.push(`Recent evicted historyId: ${JSON.stringify(historyId)}.`);
	if (toolReference) {
		lines.push(`Tool name: ${toolReference.toolName}.`);
		lines.push(`Read evicted tool output with read_context_output(${JSON.stringify({
			historyId: toolReference.historyId,
			source: "toolResult",
			toolCallId: toolReference.toolCallId,
			offset: 0,
			limit: 2000,
		})}).`);
	}
	return lines;
}

/** The conversation fills at most its section cap and whatever `maxCharacters` leaves after the header. */
export function pagingNotice(
	budgetTokens: number,
	historyId: string | undefined,
	toolReference?: ToolRecoveryReference,
	conversation?: EvictedConversation,
	maxCharacters = Number.POSITIVE_INFINITY,
): UserMessage {
	const header = noticeHeader(budgetTokens, historyId, toolReference, true);
	const room = Math.min(conversationCharacterLimit(budgetTokens), maxCharacters - header.join("\n").length);
	const conversationLines = conversation?.sectionLines(room) ?? [];
	const lines = conversationLines.length > 0 ? [...header, ...conversationLines] : noticeHeader(budgetTokens, historyId, toolReference, false);
	return temporaryUserMessage(lines.join("\n"));
}

export function pagingNoticeKey(historyId: string | undefined, toolReference: ToolRecoveryReference | undefined): string {
	return JSON.stringify([
		historyId,
		toolReference?.historyId,
		toolReference?.toolCallId,
		toolReference?.toolName,
	]);
}

export function protectedOverflowNotice(budgetTokens: number): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result exchange is present in full for this follow-up call.",
		`The normal rolling budget is ${budgetTokens.toLocaleString("en-US")} estimated tokens.`,
		"This exchange can leave context after this call.",
		"Use search_history or browse_history, then load_history or read_context_output, to recover it.",
	].join("\n"));
}

export function recoveryNotice(): UserMessage {
	return temporaryUserMessage([
		"[Context paging notice — generated by the extension]",
		"The newest tool-result payloads were replaced with recovery references or exclusion notices because they exceeded the active model context window.",
		"For recoverable results, use read_context_output with the exact arguments in their replacements.",
	].join("\n"));
}
