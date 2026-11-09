import type { UserMessage } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./history.ts";
import type { ConversationRecords } from "./paging-notice.ts";

export type ContextCutKey = { readonly historyId: string; readonly toolCallId?: string };
export type ContextCutFrontier =
	| { readonly kind: "prefix" | "completedTurn"; readonly lastEvicted: ContextCutKey }
	| { readonly kind: "partialTurn"; readonly userHistoryId?: string; readonly lastEvicted: ContextCutKey };
export type ContextCutFallbackReason =
	| "raw-history-unavailable" | "cut-key-unresolved"
	| "keyless-no-key" | "keyless-snap-over-budget"
	| "frontier-not-in-groups";
/** Plain evicted-conversation records at this boundary; kept structuredClone-safe for snapshot persistence. */
export type ContextCutSnapshot = { readonly frontier: ContextCutFrontier; readonly notice: UserMessage; readonly conversation?: ConversationRecords };

/** Raw provenance only; the selector separately resolves this frontier in its validated groups. */
export function rawCutFrontierResolves(items: readonly HistoryItem[] | undefined, frontier: ContextCutFrontier): boolean {
	if (!items) return false;
	const unique = new Map<string, HistoryItem | undefined>();
	for (const item of items) unique.set(item.id, unique.has(item.id) ? undefined : item);
	const anchor = unique.get(frontier.lastEvicted.historyId);
	if (!anchor) return false;
	if (frontier.lastEvicted.toolCallId !== undefined && (anchor.kind !== "modelTurn"
		|| !anchor.assistantMessage.content.some((block) => block.type === "toolCall" && block.id === frontier.lastEvicted.toolCallId))) return false;
	if (frontier.kind !== "partialTurn") return true;
	if (anchor.kind !== "modelTurn") return false;
	return frontier.userHistoryId === undefined || unique.get(frontier.userHistoryId)?.kind === "user";
}

/** Stores only the last successful immutable key/notice, never a transcript or raw-history array. */
export class ContextCutState {
	private snapshot: ContextCutSnapshot | undefined;

	prepare(rawHistoryItems: readonly HistoryItem[] | undefined): ContextCutSnapshot | undefined {
		if (this.snapshot && !rawCutFrontierResolves(rawHistoryItems, this.snapshot.frontier)) this.reset();
		return this.snapshot;
	}

	commit(snapshot: ContextCutSnapshot | undefined): void {
		this.snapshot = snapshot;
	}

	reset(): void {
		this.snapshot = undefined;
	}
}
