export const MAXIMUM_RECOVERY_REPLY_BYTES = 16_384;
export const MAXIMUM_INLINE_PART_BYTES = 4_096;
/** No page of a 16 KiB reply can hold more UTF-16 code units or part descriptions than this. */
export const MAXIMUM_PAGE_LIMIT = MAXIMUM_RECOVERY_REPLY_BYTES;
/** Page headers repeat both values twice, so these bounds keep room for a body at any offset. */
export const MAXIMUM_HISTORY_ID_CHARACTERS = 128;
export const MAXIMUM_PART_CHARACTERS = 512;

/** The model reads only content, so details stays empty instead of halving the budget with a copy. */
function textReply(texts: readonly string[]) {
	return { content: texts.map((text) => ({ type: "text" as const, text })), details: undefined };
}

function serialized(payload: unknown): string {
	const text = JSON.stringify(payload);
	if (text === undefined) throw new Error("Context paging response could not be serialized.");
	return text;
}

/** Count the complete serialized result, including the escaping of every text block. */
export function fitsRecoveryText(texts: readonly string[]): boolean {
	return Buffer.byteLength(JSON.stringify(textReply(texts)), "utf8") <= MAXIMUM_RECOVERY_REPLY_BYTES;
}

export function recoveryTextReply(texts: readonly string[]) {
	if (!fitsRecoveryText(texts)) throw new Error("Context paging text reply exceeds the 16 KiB byte limit.");
	return textReply(texts);
}

export function fitsRecoveryResponse(payload: unknown): boolean {
	return fitsRecoveryText([serialized(payload)]);
}

export function recoveryResponse(payload: unknown) {
	return recoveryTextReply([serialized(payload)]);
}
