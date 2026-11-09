import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calibrateResponse, type ContextTokenEstimates, type ResponseCalibration } from "./context-calibration.ts";
import { MessageCostCache, type MessageKeyResolver } from "./context-costs.ts";

type SnapshotMessage = {
	message: AgentMessage;
	fingerprint: string;
	tokens: number;
	persistent: boolean;
};

type SelectedRequest = {
	messages: readonly SnapshotMessage[];
	residentTokens: number;
};

type ResponseAnchor = SelectedRequest & {
	response: SnapshotMessage;
	calibration?: ResponseCalibration;
};

function validUsageTokens(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function usageTokens(message: AgentMessage): number | undefined {
	if (message.role !== "assistant") return undefined;
	const assistant = message as AgentMessage & {
		stopReason?: unknown;
		usage?: Record<string, unknown>;
	};
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) return undefined;
	// This is Pi's calculateContextTokens choice: a truthy total wins over components.
	const components = (assistant.usage.input as number)
		+ (assistant.usage.output as number)
		+ (assistant.usage.cacheRead as number)
		+ (assistant.usage.cacheWrite as number);
	const total = assistant.usage.totalTokens || components;
	return validUsageTokens(total) ? total : undefined;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]));
	}
	return value;
}

/** Links a successful provider response to the exact context snapshot selected for it. */
export class ContextUsageTracker {
	private pending: SelectedRequest | undefined;
	private anchor: ResponseAnchor | undefined;
	private residentOverhead: number | undefined;
	private preparedTokenEstimates: ContextTokenEstimates | undefined;
	/** Valid only for the original messages of the latest successful prepare(). */
	get tokenEstimates(): ContextTokenEstimates | undefined { return this.preparedTokenEstimates; }
	private readonly fingerprints = new WeakMap<AgentMessage, string>();
	private readonly estimates = new WeakMap<AgentMessage, number>();
	private readonly costs: MessageCostCache | undefined;
	private keyFor: MessageKeyResolver | undefined;

	constructor(costs?: MessageCostCache) {
		this.costs = costs;
	}

	/** Binds entry-derived cache keys for the current request's messages; call after refreshing raw items. */
	bindKeys(resolver: MessageKeyResolver | undefined): void {
		this.keyFor = resolver;
	}

	prepare(
		messages: readonly AgentMessage[],
		residentTokens: number,
		contextTokens: unknown,
		persistentMessages?: readonly AgentMessage[],
	): number | undefined {
		this.preparedTokenEstimates = undefined;
		if (!validUsageTokens(contextTokens) || !this.anchor || !Number.isFinite(residentTokens) || residentTokens < 0) return undefined;
		const persistent = persistentMessages ?? messages;
		let persistentResponseIndex = persistent.length - 1;
		while (persistentResponseIndex >= 0 && usageTokens(persistent[persistentResponseIndex]!) === undefined) {
			persistentResponseIndex--;
		}
		if (persistentResponseIndex < 0
			|| this.fingerprint(persistent[persistentResponseIndex]!) !== this.anchor.response.fingerprint) return undefined;
		// Pi status includes EVERY projected persistent message after its latest usage,
		// including system/tool updates that outgoing hooks may omit.
		const persistentTailTokens = persistent.slice(persistentResponseIndex + 1)
			.reduce((total, message) => total + this.estimate(message), 0);
		const current = this.snapshot(messages, persistent);

		for (let responseIndex = current.length - 1; responseIndex >= 0; responseIndex--) {
			if (current[responseIndex]!.fingerprint !== this.anchor.response.fingerprint) continue;
			if (!current[responseIndex]!.persistent
				|| current.slice(responseIndex + 1).some(({ message }) => usageTokens(message) !== undefined)) return undefined;
			if (!this.snapshotMatches(this.anchor.messages, current.slice(0, responseIndex))) continue;
			// Recover tracked provider usage, then apply conversational and resident deltas.
			// System metadata has zero ordinary-message weight; resident inputs cover it.
			const estimate = contextTokens - persistentTailTokens
				+ this.tokens(current)
				- this.tokens(this.anchor.messages)
				- this.anchor.response.tokens
				+ residentTokens
				- this.anchor.residentTokens;
			if (!Number.isFinite(estimate)) return undefined;
			const calibration = this.anchor.calibration;
			if (!calibration || contextTokens - persistentTailTokens !== usageTokens(this.anchor.response.message)) {
				return Math.max(0, estimate);
			}
			const messageTokens = this.calibratedMessages(current, responseIndex, calibration.messageScale);
			this.preparedTokenEstimates = { residentTokens: residentTokens + calibration.residentOverheadTokens, messageTokens };
			return Math.max(0, estimate);
		}
		return undefined;
	}

	recordSelection(
		messages: readonly AgentMessage[],
		residentTokens: number,
		persistentMessages?: readonly AgentMessage[],
	): void {
		if (!Number.isFinite(residentTokens) || residentTokens < 0) return;
		this.pending = { messages: this.snapshot(messages, persistentMessages), residentTokens };
	}

	outgoingOnly(messages: readonly AgentMessage[], persistentMessages: readonly AgentMessage[]): boolean[] {
		return this.snapshot(messages, persistentMessages).map((message) => !message.persistent);
	}

	recordResponse(message: AgentMessage): void {
		if (!this.pending) return;
		const reportedTokens = usageTokens(message);
		if (reportedTokens !== undefined) {
			const response = this.snapshot([message], [message])[0]!;
			const calibration = calibrateResponse(this.pending.residentTokens,
				this.tokens(this.pending.messages) + response.tokens, reportedTokens, this.residentOverhead,
				this.tokens(this.pending.messages.filter(({ persistent }) => !persistent)));
			this.residentOverhead = calibration?.residentOverheadTokens ?? 0;
			this.anchor = { ...this.pending, response, calibration };
		}
		this.pending = undefined;
	}

	clear(): void {
		this.pending = undefined;
		this.anchor = undefined;
		this.residentOverhead = undefined;
		this.preparedTokenEstimates = undefined;
	}

	private calibratedMessages(current: readonly SnapshotMessage[], responseIndex: number, scale: number) {
		const messageTokens = current.map(({ tokens }) => tokens);
		let cursor = responseIndex - 1;
		// Match backwards so restored identical prefixes keep their local cost.
		// snapshotMatches already proves that this ordered subsequence exists.
		for (let index = this.anchor!.messages.length - 1; index >= 0; index--) {
			const saved = this.anchor!.messages[index]!;
			// Transient notices and instructions keep their local cost.
			if (!saved.persistent) continue;
			while (current[cursor]!.fingerprint !== saved.fingerprint || !current[cursor]!.persistent) cursor--;
			messageTokens[cursor] = saved.tokens * scale;
			cursor--;
		}
		messageTokens[responseIndex] = this.anchor!.response.tokens * scale;
		return messageTokens;
	}

	private snapshot(messages: readonly AgentMessage[], persistentMessages = messages): SnapshotMessage[] {
		let persistentIndex = 0;
		return messages.map((message) => {
			const fingerprint = this.fingerprint(message);
			if (message.role === "system") return { message, fingerprint, tokens: 0, persistent: false };
			let candidateIndex = persistentIndex;
			while (
				candidateIndex < persistentMessages.length
				&& this.fingerprint(persistentMessages[candidateIndex]!) !== fingerprint
			) candidateIndex++;
			const persistent = candidateIndex < persistentMessages.length;
			if (persistent) persistentIndex = candidateIndex + 1;
			return { message, fingerprint, tokens: this.estimate(message), persistent };
		});
	}

	private snapshotMatches(anchor: readonly SnapshotMessage[], current: readonly SnapshotMessage[]): boolean {
		const required = anchor.filter((message) => message.persistent);
		let currentIndex = 0;
		for (const message of required) {
			while (
				currentIndex < current.length
				&& (!current[currentIndex]!.persistent || current[currentIndex]!.fingerprint !== message.fingerprint)
			) currentIndex++;
			if (currentIndex === current.length) return false;
			currentIndex++;
		}
		return true;
	}

	private fingerprint(message: AgentMessage): string {
		const key = this.keyFor?.(message);
		if (this.costs) return this.costs.fingerprint(message, key, () => JSON.stringify(stableValue(message)));
		const cached = this.fingerprints.get(message);
		if (cached !== undefined) return cached;
		const fingerprint = JSON.stringify(stableValue(message));
		this.fingerprints.set(message, fingerprint);
		return fingerprint;
	}

	private estimate(message: AgentMessage): number {
		const key = this.keyFor?.(message);
		if (this.costs) return this.costs.estimate(message, key, () => estimateTokens(message));
		const cached = this.estimates.get(message);
		if (cached !== undefined) return cached;
		const estimate = estimateTokens(message);
		this.estimates.set(message, estimate);
		return estimate;
	}

	private tokens(messages: readonly SnapshotMessage[]): number {
		return messages.reduce((total, message) => total + message.tokens, 0);
	}
}
