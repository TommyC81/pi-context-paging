import type { RecoveryHistoryItem } from "./recovery-content.ts";
import type { HistoryReference } from "./navigator.ts";
import { describeHistoryPart, historyParts, isRecoveryImage, serializeRecoveryPart, type HistoryPartDescription } from "./recovery-parts.ts";
import { fitsRecoveryResponse, MAXIMUM_INLINE_PART_BYTES, MAXIMUM_PAGE_LIMIT, recoveryResponse } from "./recovery-response.ts";

type DeferredItem = {
	id: string;
	kind: RecoveryHistoryItem["kind"];
	deferred: true;
	parts: HistoryPartDescription[];
	totalParts: number;
	nextPartOffset: number | null;
	readParts: { historyId: string; mode: "parts"; offset: number };
};

type CompactReference = HistoryReference | { historyId: string; detailsDeferred: true };

function containsImage(value: unknown): boolean {
	return isRecoveryImage(value) || (typeof value === "object" && value !== null && Object.values(value).some(containsImage));
}

function deferredItem(item: RecoveryHistoryItem): DeferredItem {
	return {
		id: item.id, kind: item.kind, deferred: true, parts: [],
		totalParts: historyParts(item).length, nextPartOffset: 0,
		readParts: { historyId: item.id, mode: "parts", offset: 0 },
	};
}

/** Reserve every ID and continuation before spending the shared budget on content. */
export function boundedHistoryReply(items?: readonly RecoveryHistoryItem[], references?: readonly HistoryReference[]) {
	const loaded: (RecoveryHistoryItem | DeferredItem)[] = (items ?? []).map(deferredItem);
	const compact: CompactReference[] = [...references ?? []];
	const payload = {
		...(references === undefined ? {} : { references: compact }),
		...(items === undefined ? {} : { items: loaded }),
		...(items === undefined || references === undefined ? {} : {
			unloadedHistoryIds: references.slice(items.length).map((reference) => reference.historyId),
		}),
	};
	// Keep every reference, replacing the largest optional metadata first.
	const largestFirst = compact.map((reference, index) => ({ index, bytes: Buffer.byteLength(JSON.stringify(reference), "utf8") }))
		.sort((a, b) => b.bytes - a.bytes);
	for (const { index } of largestFirst) {
		if (fitsRecoveryResponse(payload)) break;
		compact[index] = { historyId: compact[index].historyId, detailsDeferred: true };
	}
	if (!fitsRecoveryResponse(payload)) return recoveryResponse(payload);

	// Smallest first, so a large first item cannot consume the budget needed by a later small item.
	const candidates = (items ?? []).flatMap((item, index) => containsImage(item) ? []
		: [{ item, index, bytes: Buffer.byteLength(serializeRecoveryPart(item, ""), "utf8") }]);
	for (const { item, index } of candidates.sort((a, b) => a.bytes - b.bytes)) {
		const deferred = loaded[index];
		loaded[index] = item;
		if (!fitsRecoveryResponse(payload)) loaded[index] = deferred;
	}
	for (const [index, item] of (items ?? []).entries()) {
		const deferred = loaded[index];
		if (!("deferred" in deferred)) continue;
		const parts = historyParts(item);
		for (const part of parts) {
			const description = describeHistoryPart(item, part);
			deferred.parts.push(description);
			deferred.nextPartOffset = deferred.parts.length === parts.length ? null : deferred.parts.length;
			deferred.readParts.offset = deferred.nextPartOffset ?? 0;
			if (Buffer.byteLength(JSON.stringify(description), "utf8") > MAXIMUM_INLINE_PART_BYTES || !fitsRecoveryResponse(payload)) {
				deferred.parts.pop();
				deferred.nextPartOffset = deferred.parts.length;
				deferred.readParts.offset = deferred.parts.length;
				break;
			}
		}
	}
	return recoveryResponse(payload);
}

/** The reply budget cuts each page; limit only caps the description count. */
export function historyPartsPage(item: RecoveryHistoryItem, offset = 0, limit = MAXIMUM_PAGE_LIMIT) {
	const parts = historyParts(item);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > parts.length) throw new Error("Invalid part-list offset.");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PAGE_LIMIT) throw new Error("Invalid part-list limit.");
	const page = { parts: [] as HistoryPartDescription[], offset, nextOffset: offset < parts.length ? offset as number | null : null, totalParts: parts.length };
	for (let index = offset; index < parts.length && page.parts.length < limit; index++) {
		page.parts.push(describeHistoryPart(item, parts[index]));
		page.nextOffset = index + 1 === parts.length ? null : index + 1;
		if (!fitsRecoveryResponse(page)) {
			page.parts.pop();
			page.nextOffset = index;
			break;
		}
	}
	if (page.parts.length === 0 && offset < parts.length) throw new Error("Recovery part description exceeds the reply budget.");
	return page;
}
