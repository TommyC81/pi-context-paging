import type { ImageContent } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./history.ts";
import { recoveryHistoryItem, type RecoveryHistoryItem } from "./recovery-content.ts";

export type HistoryPart = { part: string; value: unknown };
export type PartReadHandle = { historyId: string; part: string; mode?: "image" };
export type HistoryPartDescription = {
	part: string;
	type: string;
	bytes: number;
	preview?: string;
	read: PartReadHandle;
};

export function publicHistoryItem(items: readonly HistoryItem[], historyId: string): RecoveryHistoryItem {
	const raw = items.find((item) => item.id === historyId);
	if (raw === undefined) throw new Error(`Unknown history ID ${historyId}.`);
	const item = recoveryHistoryItem(raw);
	if (item === undefined) throw new Error("History item is not public recovery output.");
	return item;
}

export function isRecoveryImage(value: unknown): value is ImageContent {
	return typeof value === "object" && value !== null
		&& (value as ImageContent).type === "image"
		&& typeof (value as ImageContent).data === "string"
		&& typeof (value as ImageContent).mimeType === "string";
}

const escapeKey = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

// Real tool call IDs reach 92 characters, so a clipped choice stays usable.
const MAXIMUM_CHOICE_CHARACTERS = 160;
const MAXIMUM_CHOICES_BYTES = 1_536;

/** Shorten a value echoed in an error without splitting a surrogate pair. */
export function clipValue(value: string): string {
	if (value.length <= MAXIMUM_CHOICE_CHARACTERS) return value;
	let end = MAXIMUM_CHOICE_CHARACTERS - 1;
	if (/[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
	return `${value.slice(0, end)}…`;
}

/** Keep error messages small when an item has many or long parts or results. */
export function listChoices(choices: readonly string[], limit = 20): string {
	if (choices.length === 0) return "none";
	const shown: string[] = [];
	let bytes = 0;
	for (const choice of choices.slice(0, limit)) {
		const clipped = clipValue(choice);
		bytes += Buffer.byteLength(JSON.stringify(clipped), "utf8");
		if (bytes > MAXIMUM_CHOICES_BYTES) break;
		shown.push(clipped);
	}
	const omitted = choices.length - shown.length;
	return omitted > 0 ? `${shown.join(", ")}, and ${omitted} more` : shown.join(", ");
}

function unknownPart(item: RecoveryHistoryItem): Error {
	const pointers = historyParts(item).map((part) => JSON.stringify(part.part));
	return new Error(`Unknown public recovery part. Public parts: ${listChoices(pointers)}. `
		+ "Use read_context_output with mode \"parts\" to list them with read handles.");
}

/** Select only own public fields; null assistant slots cannot be read around. */
export function selectHistoryPart(item: RecoveryHistoryItem, pointer: string): unknown {
	if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/u.test(pointer)) {
		throw new Error("Invalid recovery part pointer.");
	}
	let value: unknown = item;
	for (const segment of pointer === "" ? [] : pointer.slice(1).split("/")) {
		const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (isRecoveryImage(value)) throw new Error("Read image attachments through their image handles, not image fields.");
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) throw unknownPart(item);
		value = (value as Record<string, unknown>)[key];
	}
	if (value === undefined || (value === null && /^\/assistantMessage\/content\/\d+$/u.test(pointer))) throw unknownPart(item);
	return value;
}

/** Strings and plain text blocks read back as their text, without JSON escaping. */
function plainText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return undefined;
	const block = value as Record<string, unknown>;
	const keys = Object.keys(block);
	return keys.length === 2 && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/** List content separately; the root handle also recovers headers and other public fields. */
export function historyParts(item: RecoveryHistoryItem): HistoryPart[] {
	const parts: HistoryPart[] = [];
	const addContent = (content: unknown, path: string) => {
		if (Array.isArray(content)) content.forEach((value, index) => {
			if (value != null) parts.push({ part: `${path}/${index}`, value });
		});
		else parts.push({ part: path, value: content });
	};
	if (item.kind === "user") addContent(item.userMessage.content, "/userMessage/content");
	else {
		addContent(item.assistantMessage.content, "/assistantMessage/content");
		item.toolResults.forEach((result, index) => {
			addContent(result.content, `/toolResults/${index}/content`);
			if (result.details !== undefined) parts.push({ part: `/toolResults/${index}/details`, value: result.details });
		});
		parts.push({ part: "/metadata", value: item.metadata });
	}
	parts.push({ part: "", value: item });
	return parts;
}

function imageMetadata(image: ImageContent, historyId: string, part: string) {
	const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
	return {
		type: "image" as const,
		mimeType: image.mimeType,
		bytes: Math.max(0, Math.floor(image.data.length * 3 / 4) - padding),
		read: { historyId, part, mode: "image" as const },
	};
}

/** Image bytes stay in native attachments, never JSON text, even in aggregate reads. */
export function serializeRecoveryPart(item: RecoveryHistoryItem, pointer: string): string {
	const value = selectHistoryPart(item, pointer);
	const paths = new WeakMap<object, string>();
	if (typeof value === "object" && value !== null) paths.set(value, pointer);
	const text = JSON.stringify(value, function (key, child) {
		const parentPath = paths.get(this);
		const path = parentPath === undefined ? pointer : `${parentPath}/${escapeKey(key)}`;
		if (isRecoveryImage(child)) return imageMetadata(child, item.id, path);
		if (typeof child === "object" && child !== null) paths.set(child, path);
		return child;
	});
	if (text === undefined) throw new Error("Recovery part could not be serialized.");
	return text;
}

export type RecoveryPartText = { format: "text" | "json"; text: string };

/** Text-mode pages slice this representation; every other part keeps its image-safe JSON. */
export function recoveryPartText(item: RecoveryHistoryItem, pointer: string): RecoveryPartText {
	const text = plainText(selectHistoryPart(item, pointer));
	return text === undefined ? { format: "json", text: serializeRecoveryPart(item, pointer) } : { format: "text", text };
}

export function describeHistoryPart(item: RecoveryHistoryItem, part: HistoryPart): HistoryPartDescription {
	if (isRecoveryImage(part.value)) {
		const metadata = imageMetadata(part.value, item.id, part.part);
		return { part: part.part, type: "image", bytes: metadata.bytes, read: metadata.read };
	}
	const { format, text } = recoveryPartText(item, part.part);
	const type = format === "text" ? "text" : typeof part.value === "object" && part.value !== null && "type" in part.value
		&& (part.value.type === "text" || part.value.type === "toolCall") ? part.value.type : "json";
	return {
		part: part.part,
		type,
		bytes: Buffer.byteLength(text, "utf8"),
		preview: text.slice(0, 160).replace(/[\uD800-\uDBFF]$/u, ""),
		read: { historyId: item.id, part: part.part },
	};
}
