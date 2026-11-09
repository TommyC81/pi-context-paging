import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HistoryItem } from "./history.ts";

/** Per-message costs stored under entry-derived keys; each field is filled lazily. */
export type MessageCosts = {
	fingerprint?: string;
	estimate?: number;
};

/**
 * Cross-request cost cache for journal-backed messages. Entry content is immutable once
 * appended, so an entry-derived key addresses stable costs until an edit entry invalidates
 * them (see the extension's paging-state reset). Transient messages fall back to a WeakMap,
 * which serves a single request's fresh objects.
 */
export class MessageCostCache {
	private readonly byKey = new Map<string, MessageCosts>();
	private readonly byObject = new WeakMap<object, MessageCosts>();

	fingerprint(message: object, key: string | undefined, compute: () => string): string {
		const costs = this.costsFor(message, key);
		if (costs.fingerprint !== undefined) return costs.fingerprint;
		const fingerprint = compute();
		costs.fingerprint = fingerprint;
		return fingerprint;
	}

	estimate(message: object, key: string | undefined, compute: () => number): number {
		const costs = this.costsFor(message, key);
		if (costs.estimate !== undefined) return costs.estimate;
		const estimate = compute();
		costs.estimate = estimate;
		return estimate;
	}

	clear(): void {
		this.byKey.clear();
	}

	private costsFor(message: object, key: string | undefined): MessageCosts {
		if (key !== undefined) {
			const keyed = this.byKey.get(key);
			if (keyed) return keyed;
			const created: MessageCosts = {};
			this.byKey.set(key, created);
			this.byObject.set(message, created);
			return created;
		}
		const byObject = this.byObject.get(message);
		if (byObject) return byObject;
		const created: MessageCosts = {};
		this.byObject.set(message, created);
		return created;
	}
}

export type MessageKeyResolver = (message: AgentMessage) => string | undefined;

type ToolCallLike = { id: string };

function toolCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (typeof block === "object" && block !== null
			&& (block as { type?: unknown }).type === "toolCall"
			&& typeof (block as { id?: unknown }).id === "string") {
			return [(block as ToolCallLike).id];
		}
		return [];
	});
}

/**
 * Binds outgoing messages to entry-derived keys without serialization: an assistant message
 * binds through its tool-call ids to the owning turn's entry id, a tool result binds by its
 * toolCallId. User and transient messages return undefined and stay on the WeakMap fallback.
 */
export function historyItemKeyResolver(items: readonly HistoryItem[]): MessageKeyResolver {
	const turnsByCallId = new Map<string, string>();
	for (const item of items) {
		if (item.kind !== "modelTurn") continue;
		for (const call of [...item.assistantMessage.content, ...item.toolResults]) {
			if (typeof call === "object" && call !== null) {
				const ids = toolCallIds([call]);
				if (ids.length === 0 && (call as { toolCallId?: unknown }).toolCallId !== undefined) {
					ids.push((call as { toolCallId: string }).toolCallId);
				}
				for (const id of ids) turnsByCallId.set(id, item.id);
			}
		}
	}
	return (message: AgentMessage): string | undefined => {
		if (message.role === "toolResult") {
			const turn = turnsByCallId.get(message.toolCallId);
			return turn === undefined ? undefined : `${turn}#${message.toolCallId}`;
		}
		if (message.role === "assistant") {
			for (const id of toolCallIds(message.content)) {
				const turn = turnsByCallId.get(id);
				if (turn !== undefined) return turn;
			}
		}
		return undefined;
	};
}
