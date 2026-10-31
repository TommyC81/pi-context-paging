import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TProperties } from "typebox";
import type { HistoryItem } from "./history.ts";
import { HistoryNavigator, type HistoryBrowseInput, type HistorySearchInput } from "./navigator.ts";
import { contextOutputTexts, readContextOutput, validateHandleLengths, type ContextOutputReadInput } from "./output-pages.ts";
import { boundedHistoryReply, historyPartsPage } from "./recovery-loads.ts";
import { describeHistoryPart, isRecoveryImage, publicHistoryItem, selectHistoryPart } from "./recovery-parts.ts";
import { MAXIMUM_HISTORY_ID_CHARACTERS, MAXIMUM_PAGE_LIMIT, MAXIMUM_PART_CHARACTERS, recoveryResponse, recoveryTextReply } from "./recovery-response.ts";

export type HistorySnapshot = {
	allItems: readonly HistoryItem[];
	navigator: HistoryNavigator;
};

export type ContextPagingToolDependencies = {
	isEnabled(): boolean;
	snapshot(ctx: ExtensionContext): HistorySnapshot;
};

const strictObject = <T extends TProperties>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const searchHistoryParameters = strictObject({
	query: Type.String({ maxLength: 200 }),
	files: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
	tools: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), {
		maxItems: 10,
		description: "Match any listed tool name. Omit or pass an empty list for no tool restriction.",
	})),
	failed: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	load: Type.Optional(Type.Boolean()),
});

const browseHistoryParameters = strictObject({
	historyId: Type.Optional(Type.String({ maxLength: 128 })),
	sequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
	direction: StringEnum(["backward", "forward", "around"] as const),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
	stride: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
});

const loadHistoryParameters = strictObject({
	historyIds: Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 3 }),
});

const readContextOutputParameters = strictObject({
	historyId: Type.String({ maxLength: MAXIMUM_HISTORY_ID_CHARACTERS }),
	source: Type.Optional(StringEnum(["assistant", "toolResult"] as const)),
	part: Type.Optional(Type.String({ maxLength: MAXIMUM_PART_CHARACTERS, description: "Exact public part pointer from a recovery handle." })),
	mode: Type.Optional(StringEnum(["text", "parts", "image"] as const)),
	contentIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	toolCallId: Type.Optional(Type.String()),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: MAXIMUM_PAGE_LIMIT,
		description: "Optional page cap in UTF-16 code units for text mode, or in part descriptions for mode:parts. Omit it to fill the 16 KiB reply.",
	})),
});

type SearchHistoryInput = HistorySearchInput & { load?: boolean };

function readReply(items: readonly HistoryItem[], params: ContextOutputReadInput) {
	const mode = params.mode ?? "text";
	validateHandleLengths(params);
	if (mode === "text") return recoveryTextReply(contextOutputTexts(readContextOutput(items, params)));
	if (params.source !== undefined || params.contentIndex !== undefined || params.toolCallId !== undefined) {
		throw new Error("Part-list and image modes do not accept legacy output selectors.");
	}
	const item = publicHistoryItem(items, params.historyId);
	if (mode === "parts") {
		if (params.part !== undefined) throw new Error("Part-list mode does not accept a part selector.");
		return recoveryResponse(historyPartsPage(item, params.offset, params.limit));
	}
	if (mode !== "image") throw new Error("Unknown recovery read mode.");
	if (params.part === undefined || params.offset !== undefined || params.limit !== undefined) {
		throw new Error("Image mode requires a part handle without text-page bounds.");
	}
	const image = selectHistoryPart(item, params.part);
	if (!isRecoveryImage(image)) throw new Error("The selected public part is not an image.");
	const metadata = describeHistoryPart(item, { part: params.part, value: image });
	const reply = recoveryResponse(metadata);
	// Only this explicit branch can return image bytes, as native image content.
	return { ...reply, content: [...reply.content, { type: "image" as const, data: image.data, mimeType: image.mimeType }] };
}

function snapshot(dependencies: ContextPagingToolDependencies, ctx: ExtensionContext): HistorySnapshot {
	if (!dependencies.isEnabled()) throw new Error("Context paging recovery tools are disabled.");
	return dependencies.snapshot(ctx);
}

/** Registers the four public tools that recover paged session context. */
export function registerContextPagingTools(
	pi: ExtensionAPI,
	dependencies: ContextPagingToolDependencies,
): void {
	pi.registerTool({
		name: "search_history",
		label: "Search History",
		description: "search_history finds public recovery references in paged session history. Query previews show context around a matching search term, including public tool output. With load:true, it loads up to three items and lists unloadedHistoryIds without dropping references. Text replies are capped at 16 KiB. Large items return deferred parts and read handles, not full bodies. Use load_history or read_context_output to follow them.",
		parameters: searchHistoryParameters,
		async execute(_toolCallId, params: SearchHistoryInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			const references = current.navigator.search(params);
			if (!params.load) return boundedHistoryReply(undefined, references);
			const historyIds = references.slice(0, 3).map((reference) => reference.historyId);
			return boundedHistoryReply(historyIds.length === 0 ? [] : current.navigator.load(historyIds), references);
		},
	});

	pi.registerTool({
		name: "browse_history",
		label: "Browse History",
		description: "browse_history returns compact public recovery references around paged session history. Use load_history for public items or read_context_output for repeated output pages.",
		parameters: browseHistoryParameters,
		async execute(_toolCallId, params: HistoryBrowseInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return boundedHistoryReply(undefined, current.navigator.browse(params));
		},
	});

	pi.registerTool({
		name: "load_history",
		label: "Load History",
		description: "load_history returns public recovery items in requested order within a 16 KiB complete text reply. Items load whole, smallest first, while they fit; the rest return deferred parts and read handles. Follow readParts with read_context_output for additional parts. Image metadata has an explicit native attachment handle. Omitted assistant blocks keep their original contentIndex values.",
		parameters: loadHistoryParameters,
		async execute(_toolCallId, params: { historyIds: string[] }, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return boundedHistoryReply(current.navigator.load(params.historyIds));
		},
	});

	pi.registerTool({
		name: "read_context_output",
		label: "Read Context Output",
		description: "read_context_output reads public history through a part handle or legacy source selector. Default text mode returns a JSON header block, then the page as a second text block: plain text for strings and for text blocks with only type and string text, exact JSON for other parts. Pages fill a complete reply capped at 16 KiB. While more remains, the header has next, the exact arguments for the next read. With source assistant, contentIndex may be omitted when the turn has exactly one public text block, or no text block and one public block. With source toolResult, toolCallId may be omitted when the turn has exactly one public tool result. mode:parts pages part descriptions; mode:image returns one native image attachment from an image handle, exempt from the text cap. Image data never becomes text. Private blocks and paging exchanges are unavailable.",
		parameters: readContextOutputParameters,
		async execute(_toolCallId, params: ContextOutputReadInput, _signal, _onUpdate, ctx) {
			const current = snapshot(dependencies, ctx);
			return readReply(current.allItems, params);
		},
	});
}
