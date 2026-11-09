import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PAGING_TOOL_NAMES = [
	"search_history",
	"browse_history",
	"load_history",
	"read_context_output",
] as const;

export type PagingToolName = typeof PAGING_TOOL_NAMES[number];

export type HistoryMetadata = {
	tools: string[];
	files: string[];
	failed: boolean;
};

export type UserHistoryItem = {
	id: string;
	kind: "user";
	sequence: number;
	timestamp: string;
	userMessage: UserMessage;
};

export type ModelTurnHistoryItem = {
	id: string;
	kind: "modelTurn";
	sequence: number;
	timestamp: string;
	assistantMessage: AssistantMessage;
	toolResults: ToolResultMessage[];
	metadata: HistoryMetadata;
	/** Saved incomplete exchange identified at a session/branch restore, not a live refresh. */
	interruptedByRestore?: true;
};

export type HistoryItem = UserHistoryItem | ModelTurnHistoryItem;

export type HistoryProjectionErrorCode =
	| "DUPLICATE_TOOL_CALL"
	| "ORPHAN_TOOL_RESULT"
	| "DUPLICATE_TOOL_RESULT"
	| "INCOMPLETE_TOOL_RESULTS"
	| "MISMATCHED_TOOL_RESULT";

export class HistoryProjectionError extends Error {
	readonly code: HistoryProjectionErrorCode;

	constructor(code: HistoryProjectionErrorCode, message = code) {
		super(message);
		this.code = code;
		this.name = "HistoryProjectionError";
	}
}

const PAGING_TOOL_SET = new Set<string>(PAGING_TOOL_NAMES);
const FILE_ARGUMENT_KEYS = new Set(["path", "file", "files", "filepath", "file_path"]);

type RelevantMessageEntry = Extract<SessionEntry, { type: "message" }>;

/** A message entry paired with its index in the raw entry array, so projection watermarks address raw entries. */
type RelevantEntry = { entry: RelevantMessageEntry; rawIndex: number };

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "toolCall"
		&& typeof (block as { id?: unknown }).id === "string"
		&& typeof (block as { name?: unknown }).name === "string";
}

function toolCalls(message: AssistantMessage): ToolCallBlock[] {
	return message.content.filter(isToolCallBlock);
}

export function isInterruptedAssistantMessage(message: AssistantMessage): boolean {
	return message.stopReason === "aborted" || message.stopReason === "error";
}

function collectFiles(value: unknown, files: string[], seen: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectFiles(item, files, seen);
		return;
	}
	if (typeof value !== "object" || value === null) return;

	for (const [key, child] of Object.entries(value)) {
		if (FILE_ARGUMENT_KEYS.has(key.toLowerCase())) {
			const candidates = typeof child === "string"
				? [child]
				: Array.isArray(child) ? child.filter((item): item is string => typeof item === "string") : [];
			for (const file of candidates) {
				if (!seen.has(file)) {
					seen.add(file);
					files.push(file);
				}
			}
		}
		collectFiles(child, files, seen);
	}
}

export function metadataFor(message: AssistantMessage, results: ToolResultMessage[], interruptedByRestore = false): HistoryMetadata {
	const files: string[] = [];
	const seenFiles = new Set<string>();
	const calls = toolCalls(message);
	for (const call of calls) collectFiles(call.arguments, files, seenFiles);
	return {
		tools: calls.map((call) => call.name),
		files,
		failed: interruptedByRestore || isInterruptedAssistantMessage(message) || results.some((result) => result.isError),
	};
}

function relevantIndexed(entries: readonly SessionEntry[]): RelevantEntry[] {
	const relevant: RelevantEntry[] = [];
	for (let rawIndex = 0; rawIndex < entries.length; rawIndex++) {
		const entry = entries[rawIndex]!;
		if (entry.type === "message"
			&& (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			relevant.push({ entry, rawIndex });
		}
	}
	return relevant;
}

export type HistoryProjectionOptions = {
	/** Only session/branch restore may identify newly discovered incomplete exchanges. */
	recoverIncomplete?: boolean;
	/** Stable saved entry IDs classified during the latest restore. */
	interruptedEntryIds?: ReadonlySet<string>;
};

/** Projection output plus, per pushed item, the raw entry index after the entries that item consumed. */
type DetailedProjection = {
	items: HistoryItem[];
	throughEntryIndexes: number[];
};

function projectDetailed(
	entries: readonly SessionEntry[],
	options: HistoryProjectionOptions,
	sequenceOffset = 0,
): DetailedProjection {
	const messages = relevantIndexed(entries);
	const items: HistoryItem[] = [];
	const throughEntryIndexes: number[] = [];

	for (let index = 0; index < messages.length; index++) {
		const { entry, rawIndex } = messages[index]!;
		if (entry.message.role === "user") {
			items.push({
				id: entry.id,
				kind: "user",
				sequence: items.length + sequenceOffset,
				timestamp: entry.timestamp,
				userMessage: entry.message,
			});
			throughEntryIndexes.push(rawIndex + 1);
			continue;
		}
		if (entry.message.role === "toolResult") {
			throw new HistoryProjectionError("ORPHAN_TOOL_RESULT");
		}

		const assistant = entry.message as AssistantMessage;
		const calls = toolCalls(assistant);
		const expectedIds = new Set(calls.map((call) => call.id));
		if (expectedIds.size !== calls.length) throw new HistoryProjectionError("DUPLICATE_TOOL_CALL");
		const seenIds = new Set<string>();
		const results: ToolResultMessage[] = [];
		let resultIndex = index + 1;
		while (resultIndex < messages.length && messages[resultIndex]!.entry.message.role === "toolResult") {
			const result = messages[resultIndex]!.entry.message as ToolResultMessage;
			if (!expectedIds.has(result.toolCallId)) {
				throw new HistoryProjectionError("MISMATCHED_TOOL_RESULT");
			}
			if (seenIds.has(result.toolCallId)) {
				throw new HistoryProjectionError("DUPLICATE_TOOL_RESULT");
			}
			seenIds.add(result.toolCallId);
			results.push(result);
			resultIndex++;
		}

		const interruptedByRestore = seenIds.size !== expectedIds.size
			&& !isInterruptedAssistantMessage(assistant)
			&& (options.recoverIncomplete === true || options.interruptedEntryIds?.has(entry.id) === true);
		if (seenIds.size !== expectedIds.size && !isInterruptedAssistantMessage(assistant) && !interruptedByRestore) {
			if (resultIndex === messages.length) break;
			throw new HistoryProjectionError("INCOMPLETE_TOOL_RESULTS");
		}

		items.push({
			id: entry.id,
			kind: "modelTurn",
			sequence: items.length + sequenceOffset,
			timestamp: entry.timestamp,
			assistantMessage: assistant,
			toolResults: results,
			metadata: metadataFor(assistant, results, interruptedByRestore),
			...(interruptedByRestore ? { interruptedByRestore: true as const } : {}),
		});
		throughEntryIndexes.push(messages[resultIndex - 1]!.rawIndex + 1);
		index = resultIndex - 1;
	}

	return { items, throughEntryIndexes };
}

/** Projects raw history without mutation; restore options retain otherwise incomplete saved exchanges. */
export function projectActiveBranch(entries: readonly SessionEntry[], options: HistoryProjectionOptions = {}): HistoryItem[] {
	return projectDetailed(entries, options).items;
}

/** A reusable projection prefix: the items through a complete-item boundary, plus that boundary. */
export type ProjectionWatermark = {
	readonly items: readonly HistoryItem[];
	/** Raw entry index of the first entry the items did not consume. */
	readonly entryIndex: number;
	/** Id of the last consumed raw entry at entryIndex - 1; undefined only when entryIndex is 0. */
	readonly lastEntryId: string | undefined;
};

export type IncrementalProjection = { items: HistoryItem[]; watermark: ProjectionWatermark };

function coldWatermark(detailed: DetailedProjection, entries: readonly SessionEntry[]): IncrementalProjection {
	const entryIndex = detailed.throughEntryIndexes.length === 0
		? 0
		: detailed.throughEntryIndexes[detailed.throughEntryIndexes.length - 1]!;
	return {
		items: detailed.items,
		watermark: { items: detailed.items, entryIndex, lastEntryId: entries[entryIndex - 1]?.id },
	};
}

/** Projects with prefix reuse across refreshes; any watermark mismatch falls back to the full projection. */
export function projectActiveBranchIncremental(
	entries: readonly SessionEntry[],
	previous?: ProjectionWatermark,
	options: HistoryProjectionOptions = {},
): IncrementalProjection {
	if (!previous || options.recoverIncomplete || options.interruptedEntryIds) {
		return coldWatermark(projectDetailed(entries, options), entries);
	}
	// Anchoring on the last consumed entry keeps appends incremental and still catches a branch switch.
	const anchored = previous.entryIndex === 0
		? previous.lastEntryId === undefined
		: previous.entryIndex <= entries.length && entries[previous.entryIndex - 1]!.id === previous.lastEntryId;
	if (!anchored) {
		return coldWatermark(projectDetailed(entries, options), entries);
	}
	if (previous.entryIndex === entries.length) {
		return { items: [...previous.items], watermark: previous };
	}
	const tail = projectDetailed(entries.slice(previous.entryIndex), options, previous.items.length);
	const items = [...previous.items, ...tail.items];
	const through = tail.throughEntryIndexes.length === 0
		? previous.entryIndex
		: previous.entryIndex + tail.throughEntryIndexes[tail.throughEntryIndexes.length - 1]!;
	return {
		items,
		watermark: tail.items.length === 0 ? previous : { items, entryIndex: through, lastEntryId: entries[through - 1]?.id },
	};
}

export function isPagingToolTurn(item: HistoryItem): boolean {
	return item.kind === "modelTurn" && item.metadata.tools.some((name) => PAGING_TOOL_SET.has(name));
}

export function findModelTurnByToolCallId(
	items: readonly HistoryItem[],
	toolCallId: string,
): ModelTurnHistoryItem | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		if (item.kind === "modelTurn" && toolCalls(item.assistantMessage).some((call) => call.id === toolCallId)) {
			return item;
		}
	}
	return undefined;
}
