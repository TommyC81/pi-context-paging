import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";
import { recoveryHistoryItem, type RecoveryHistoryItem, type RecoveryModelTurnHistoryItem } from "./recovery-content.ts";
import { clipValue, listChoices, publicHistoryItem, recoveryPartText, type RecoveryPartText } from "./recovery-parts.ts";
import { fitsRecoveryText, MAXIMUM_HISTORY_ID_CHARACTERS, MAXIMUM_PAGE_LIMIT, MAXIMUM_PART_CHARACTERS } from "./recovery-response.ts";

export type ContextOutputReadInput = {
	historyId: string;
	source?: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
	part?: string;
	mode?: "text" | "parts" | "image";
	offset?: number;
	limit?: number;
};

export type ContextOutputHeader = {
	historyId: string;
	part: string;
	format: RecoveryPartText["format"];
	offset: number;
	nextOffset: number | null;
	totalCharacters: number;
	next?: { historyId: string; part: string; offset: number; limit?: number };
};

export type ContextOutputPage = { header: ContextOutputHeader; text: string };

/** The header is JSON; the page follows unescaped in its own block, omitted when empty. */
export function contextOutputTexts(page: ContextOutputPage): string[] {
	const header = JSON.stringify(page.header);
	return page.text === "" ? [header] : [header, page.text];
}

const PARTS_HINT = "Use read_context_output with mode \"parts\" to list every public part with read handles.";

/** Headers echo these values, so long ones would leave no room for the page. */
export function validateHandleLengths(input: { historyId: string; part?: string }): void {
	if (input.historyId.length > MAXIMUM_HISTORY_ID_CHARACTERS) {
		throw new Error(`historyId must be at most ${MAXIMUM_HISTORY_ID_CHARACTERS} characters.`);
	}
	if (input.part !== undefined && input.part.length > MAXIMUM_PART_CHARACTERS) {
		throw new Error(`part must be at most ${MAXIMUM_PART_CHARACTERS} characters.`);
	}
}

function validateDiscriminator(input: ContextOutputReadInput): void {
	if (input.part !== undefined) {
		if (input.source !== undefined || input.contentIndex !== undefined || input.toolCallId !== undefined) {
			throw new Error("A part handle cannot be combined with legacy output selectors.");
		}
		return;
	}
	if (input.source === "assistant") {
		if (input.contentIndex !== undefined && (!Number.isSafeInteger(input.contentIndex) || input.contentIndex < 0)) {
			throw new Error("Assistant output contentIndex must be a nonnegative integer.");
		}
		if (input.toolCallId !== undefined) throw new Error("Assistant output does not accept toolCallId.");
		return;
	}
	if (input.source === "toolResult") {
		if (input.toolCallId !== undefined && (typeof input.toolCallId !== "string" || input.toolCallId.length === 0)) {
			throw new Error("Tool-result output toolCallId must be a nonempty string.");
		}
		if (input.contentIndex !== undefined) throw new Error("Tool-result output does not accept contentIndex.");
		return;
	}
	throw new Error("Output requires a part handle or an assistant/toolResult source.");
}

function pageInput(input: ContextOutputReadInput): { offset: number; limit?: number } {
	const offset = input.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Output offset must be a nonnegative integer.");
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_PAGE_LIMIT)) {
		throw new Error(`Output limit must be an integer from 1 to ${MAXIMUM_PAGE_LIMIT}.`);
	}
	return { offset, limit: input.limit };
}

function modelTurn(items: readonly HistoryItem[], historyId: string): ModelTurnHistoryItem {
	const item = items.find((candidate) => candidate.id === historyId);
	if (item === undefined) throw new Error(`Unknown history ID ${historyId}.`);
	if (item.kind !== "modelTurn") throw new Error(`History ID ${historyId} is not a model turn.`);
	return item;
}

/** Without contentIndex, the only public text block, or else the only public block, is the obvious choice. */
function assistantIndex(turn: ModelTurnHistoryItem, recovery: RecoveryModelTurnHistoryItem | undefined, contentIndex?: number): number {
	if (contentIndex === undefined) {
		const blocks = recovery?.assistantMessage.content.flatMap((block, index) => block === null ? [] : [{ index, type: block.type }]) ?? [];
		const texts = blocks.filter((block) => block.type === "text");
		const only = texts.length === 1 ? texts[0] : texts.length === 0 && blocks.length === 1 ? blocks[0] : undefined;
		if (only) return only.index;
		throw new Error("Assistant output needs contentIndex unless the turn has exactly one public text block or one public block. "
			+ `Public blocks: ${listChoices(blocks.map((block) => `${block.index} (${block.type})`))}. ${PARTS_HINT}`);
	}
	if (turn.assistantMessage.content[contentIndex] === undefined) throw new Error(`Unknown assistant content index ${contentIndex}.`);
	if (recovery?.assistantMessage.content[contentIndex] == null) {
		throw new Error(`Assistant content index ${contentIndex} is not public recovery output.`);
	}
	return contentIndex;
}

/** Without toolCallId, the only public tool result is the obvious choice. */
function toolResultIndex(turn: ModelTurnHistoryItem, recovery: RecoveryModelTurnHistoryItem | undefined, toolCallId?: string): number {
	const results = recovery?.toolResults ?? [];
	if (toolCallId === undefined) {
		if (results.length === 1) return 0;
		throw new Error("Tool-result output needs toolCallId unless the turn has exactly one public tool result. "
			+ `Public tool results: ${listChoices(results.map((result) => `${result.toolCallId} (${result.toolName})`))}. ${PARTS_HINT}`);
	}
	if (!turn.toolResults.some((result) => result.toolCallId === toolCallId)) throw new Error(`Unknown tool-result toolCallId ${clipValue(toolCallId)}.`);
	const index = results.findIndex((result) => result.toolCallId === toolCallId);
	if (index < 0) throw new Error("Recovery-tool output is not available. Read the original history item instead.");
	return index;
}

function selectedPart(items: readonly HistoryItem[], input: ContextOutputReadInput): { item: RecoveryHistoryItem; part: string } {
	if (input.part !== undefined) return { item: publicHistoryItem(items, input.historyId), part: input.part };
	const turn = modelTurn(items, input.historyId);
	const item = recoveryHistoryItem(turn);
	const recovery = item?.kind === "modelTurn" ? item : undefined;
	if (input.source === "assistant") {
		const index = assistantIndex(turn, recovery, input.contentIndex);
		return { item: recovery!, part: `/assistantMessage/content/${index}` };
	}
	return { item: recovery!, part: `/toolResults/${toolResultIndex(turn, recovery, input.toolCallId)}` };
}

function splitsSurrogate(text: string, index: number): boolean {
	return index > 0 && index < text.length
		&& /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]);
}

/** Exact text or image-safe JSON ranges, as long as the complete reply allows unless limit is smaller. */
export function readContextOutput(items: readonly HistoryItem[], input: ContextOutputReadInput): ContextOutputPage {
	if (input.mode !== undefined && input.mode !== "text") throw new Error("Text output requires text mode.");
	validateHandleLengths(input);
	validateDiscriminator(input);
	const { offset, limit } = pageInput(input);
	const { item, part } = selectedPart(items, input);
	const { format, text } = recoveryPartText(item, part);
	if (offset > text.length) throw new Error("Output offset exceeds the output length.");
	if (splitsSurrogate(text, offset)) throw new Error("Output offset splits a Unicode character.");
	const pageAt = (end: number): ContextOutputPage => {
		const nextOffset = end < text.length ? end : null;
		const header: ContextOutputHeader = { historyId: item.id, part, format, offset, nextOffset, totalCharacters: text.length };
		if (nextOffset !== null) header.next = { historyId: item.id, part, offset: nextOffset, ...(limit === undefined ? {} : { limit }) };
		return { header, text: text.slice(offset, end) };
	};
	// A lone surrogate costs more escaped bytes than its whole pair, so size only whole-character ends.
	const boundary = (end: number) => splitsSurrogate(text, end) ? end - 1 : end;
	const fits = (end: number) => fitsRecoveryText(contextOutputTexts(pageAt(boundary(end))));
	const end = Math.min(offset + (limit ?? MAXIMUM_PAGE_LIMIT), text.length);
	// The last page drops its next handle, so test it first; earlier ends grow with the page.
	let low = offset;
	let high = end;
	if (fits(end)) low = end;
	else high = end - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	low = boundary(low);
	if (low === offset && offset < text.length) throw new Error("Output limit is too small for the next Unicode character. Increase limit.");
	return pageAt(low);
}
