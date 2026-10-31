import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { isInterruptedAssistantMessage, type HistoryItem } from "./history.ts";

import { defaultTrimToTokens } from "./settings.ts";
import { validTokenEstimates, type ContextTokenEstimates } from "./context-calibration.ts";
import { SelectionHistoryLookup } from "./selection-history.ts";
import { pagingToolCallIds } from "./recovery-content.ts";
import { rawCutFrontierResolves, type ContextCutFrontier, type ContextCutSnapshot, type ContextCutFallbackReason } from "./context-cut.ts";
import {
	EvictedConversation, pagingNotice, pagingNoticeKey, protectedOverflowNotice, recoveryNotice, type ToolRecoveryReference,
} from "./paging-notice.ts";

export { DEFAULT_CONTEXT_TOKEN_BUDGET } from "./settings.ts";

export type ResidentToolDefinition = {
	name: string;
	description: string;
	parameters: unknown;
};

export type ContextSelectionInput = {
	messages: readonly AgentMessage[];
	systemPrompt: string;
	activeTools: readonly ResidentToolDefinition[];
	modelContextWindow: number | undefined;
	tokenBudget: number;
	/** FIFO advance destination; omission derives the adaptive target from tokenBudget. */
	trimToTokens?: number;
	/** A provider-backed full-context estimate, when its usage basis is known. */
	contextTokens?: number;
	/** Provider-backed resident and per-message costs aligned with the original input. */
	tokenEstimates?: ContextTokenEstimates;
	/** Messages present only in this outgoing request, not the persistent session branch. */
	outgoingOnly?: readonly boolean[];
	rawHistoryItems?: readonly HistoryItem[];
	cutState?: ContextCutSnapshot;
};

export type ContextSelectionMode = "within-budget" | "paged" | "protected-overflow" | "recovery";

export type ContextSelection = {
	messages: AgentMessage[];
	estimatedTokens: number;
	budgetTokens: number;
	mode: ContextSelectionMode;
	cutState: ContextCutSnapshot | undefined;
	cutFallbackReason?: ContextCutFallbackReason;
};

export type ContextSelectionErrorCode =
	| "INVALID_TOKEN_BUDGET"
	| "INVALID_TRIM_TARGET"
	| "INVALID_MODEL_CONTEXT"
	| "RESIDENT_INPUT_TOO_LARGE"
	| "ACTIVE_REQUEST_TOO_LARGE"
	| "INVALID_MESSAGE_STRUCTURE";

export class ContextSelectionError extends Error {
	readonly code: ContextSelectionErrorCode;
	readonly residentTokens?: number;
	readonly estimatedTokens?: number;
	readonly budgetTokens?: number;

	constructor(
		code: ContextSelectionErrorCode,
		message: string,
		residentTokens?: number,
		estimatedTokens?: number,
		budgetTokens?: number,
	) {
		super(message);
		this.code = code;
		this.residentTokens = residentTokens;
		this.estimatedTokens = estimatedTokens;
		this.budgetTokens = budgetTokens;
		this.name = "ContextSelectionError";
	}
}

// Canonical grouping and normalization. Validate the whole input before applying a boundary.
type ToolExchange = {
	assistant: AssistantMessage;
	results: ToolResultMessage[];
	messages: AgentMessage[];
};

type PrefixUnit = { kind: "prefix"; messages: AgentMessage[] };
type CompletedTurnUnit = { kind: "completedTurn"; messages: AgentMessage[]; anchorMessages?: readonly AgentMessage[] };
type RequestMessage = UserMessage | Extract<AgentMessage, { role: "custom" }>;

type ActiveTurnUnit = {
	kind: "activeTurn";
	request: RequestMessage[];
	exchanges: ToolExchange[];
	trailingOutgoing: AgentMessage[];
};

type GroupedContext = {
	prefixes: PrefixUnit[];
	completedTurns: CompletedTurnUnit[];
	activeTurn?: ActiveTurnUnit;
};

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "toolCall"
		&& typeof (block as { id?: unknown }).id === "string"
		&& typeof (block as { name?: unknown }).name === "string";
}

export function residentTokenEstimate(input: Pick<ContextSelectionInput, "systemPrompt" | "activeTools">): number {
	const tools = input.activeTools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	// Pi 0.87 counts the rendered system content and toolsAdded schema together.
	return Math.ceil((input.systemPrompt.length + JSON.stringify(tools).length) / 4);
}

function structureError(message: string): ContextSelectionError {
	return new ContextSelectionError("INVALID_MESSAGE_STRUCTURE", message);
}

function exchangeAt(
	messages: readonly AgentMessage[],
	index: number,
	allowIncomplete = false,
): { exchange: ToolExchange; nextIndex: number } {
	const assistant = messages[index] as AssistantMessage;
	const calls = assistant.content.filter(isToolCallBlock);
	if (calls.length === 0) {
		return { exchange: { assistant, results: [], messages: [assistant] }, nextIndex: index + 1 };
	}

	const expectedIds = new Set(calls.map((call) => call.id));
	if (expectedIds.size !== calls.length) {
		throw structureError("Canonical tool-call exchange has duplicate IDs.");
	}
	const seenIds = new Set<string>();
	const results: ToolResultMessage[] = [];
	let nextIndex = index + 1;
	while (messages[nextIndex]?.role === "toolResult") {
		const result = messages[nextIndex] as ToolResultMessage;
		if (!expectedIds.has(result.toolCallId) || seenIds.has(result.toolCallId)) {
			throw structureError("Canonical tool-result exchange has an invalid matching result.");
		}
		seenIds.add(result.toolCallId);
		results.push(result);
		nextIndex++;
	}
	if (seenIds.size !== expectedIds.size && !allowIncomplete) {
		throw structureError("Canonical tool-call exchange is incomplete.");
	}
	return { exchange: { assistant, results, messages: [assistant, ...results] }, nextIndex };
}

function normalizeInterruptedExchanges(
	messages: readonly AgentMessage[],
	outgoingOnly: readonly boolean[],
	rawHistoryItems: readonly HistoryItem[] | undefined,
): { messages: AgentMessage[]; outgoingOnly: readonly boolean[] } {
	const restoredIds = new Set((rawHistoryItems ?? [])
		.filter((item) => item.kind === "modelTurn" && item.interruptedByRestore)
		.map((item) => item.id));
	// Use unambiguous saved-entry provenance, never a tool-call ID alone.
	const history = restoredIds.size > 0 ? new SelectionHistoryLookup(rawHistoryItems) : undefined;
	const restoredMatches = history ? messages.map((message) => message.role === "assistant"
		? history.cutKey(message)?.historyId : undefined) : [];
	const restoredOccurrences = new Map<string, number>();
	for (const id of restoredMatches) {
		if (id !== undefined && restoredIds.has(id)) restoredOccurrences.set(id, (restoredOccurrences.get(id) ?? 0) + 1);
	}
	const normalized: AgentMessage[] = [];
	const normalizedOutgoingOnly: boolean[] = [];
	let removedInterruptedExchange = false;
	for (let index = 0; index < messages.length;) {
		const message = messages[index]!;
		if (message.role === "toolResult") {
			throw structureError("Canonical context contains an orphan tool result.");
		}
		if (message.role !== "assistant") {
			normalized.push(message);
			normalizedOutgoingOnly.push(outgoingOnly[index]!);
			index++;
			continue;
		}
		const historyId = restoredMatches[index];
		// An identical live tail must not inherit the saved exchange's classification.
		const interrupted = isInterruptedAssistantMessage(message)
			|| historyId !== undefined && restoredOccurrences.get(historyId) === 1;
		const { exchange, nextIndex } = exchangeAt(messages, index, interrupted);
		if (interrupted) removedInterruptedExchange = true;
		else {
			normalized.push(...exchange.messages);
			normalizedOutgoingOnly.push(...outgoingOnly.slice(index, nextIndex));
		}
		index = nextIndex;
	}
	return removedInterruptedExchange
		? { messages: normalized, outgoingOnly: normalizedOutgoingOnly }
		: { messages: messages as AgentMessage[], outgoingOnly };
}

function unitsForSegment(messages: readonly AgentMessage[]): AgentMessage[][] {
	const units: AgentMessage[][] = [];
	for (let index = 0; index < messages.length;) {
		const message = messages[index];
		if (message.role === "toolResult") throw structureError("Canonical context contains an orphan tool result.");
		if (message.role === "assistant") {
			const { exchange, nextIndex } = exchangeAt(messages, index);
			units.push(exchange.messages);
			index = nextIndex;
			continue;
		}
		units.push([message]);
		index++;
	}
	return units;
}

function requestStartIndexes(messages: readonly AgentMessage[], outgoingOnly: readonly boolean[]): number[] {
	const indexes: number[] = [];
	let followsUserRequest = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (outgoingOnly[index]) continue;
		if (message.role === "user") {
			indexes.push(index);
			followsUserRequest = true;
			continue;
		}
		if (message.role === "custom") {
			if (!followsUserRequest) indexes.push(index);
			continue;
		}
		followsUserRequest = false;
	}
	return indexes;
}

function requestEnvelope(messages: readonly AgentMessage[], start: number, outgoingOnly: readonly boolean[]): RequestMessage[] {
	const request = [messages[start] as RequestMessage];
	if (request[0].role !== "user") return request;
	for (let index = start + 1; messages[index] && (messages[index]!.role === "custom" || outgoingOnly[index]); index++) {
		request.push(messages[index] as RequestMessage);
	}
	return request;
}

function groupContext(messages: readonly AgentMessage[], outgoingOnly: readonly boolean[]): GroupedContext {
	const requestIndexes = requestStartIndexes(messages, outgoingOnly);
	if (requestIndexes.length === 0) return {
		prefixes: unitsForSegment(messages).map((messages) => ({ kind: "prefix", messages })), completedTurns: [],
	};

	const prefixes = unitsForSegment(messages.slice(0, requestIndexes[0]))
		.map((messages) => ({ kind: "prefix" as const, messages }));
	const completedTurns: CompletedTurnUnit[] = [];
	for (let turn = 0; turn < requestIndexes.length - 1; turn++) {
		const start = requestIndexes[turn];
		const end = requestIndexes[turn + 1];
		unitsForSegment(messages.slice(start, end));
		completedTurns.push({ kind: "completedTurn", messages: [...messages.slice(start, end)] });
	}

	const activeStart = requestIndexes.at(-1)!;
	const activeMessages = messages.slice(activeStart);
	const request = requestEnvelope(activeMessages, 0, outgoingOnly.slice(activeStart));
	const exchanges: ToolExchange[] = [];
	const trailingOutgoing: AgentMessage[] = [];
	for (let index = request.length; index < activeMessages.length;) {
		const message = activeMessages[index];
		if (outgoingOnly[activeStart + index]) {
			trailingOutgoing.push(message);
			index++;
			continue;
		}
		if (message.role === "toolResult") throw structureError("Canonical context contains an orphan tool result.");
		if (message.role !== "assistant") throw structureError("Canonical active turn has an unsupported message structure.");
		const { exchange, nextIndex } = exchangeAt(activeMessages, index);
		exchanges.push(exchange);
		index = nextIndex;
	}
	return { prefixes, completedTurns, activeTurn: { kind: "activeTurn", request, exchanges, trailingOutgoing } };
}

// Per-call estimates and generated notices; these never enter the cross-call state.
type TokenCache = {
	messages: Map<AgentMessage, number>;
	units: WeakMap<readonly AgentMessage[], number>;
};

function messageEstimate(message: AgentMessage, cache: TokenCache): number {
	// Rendered system/tool metadata is already covered by residentTokenEstimate.
	if (message.role === "system") return 0;
	const cached = cache.messages.get(message);
	if (cached !== undefined) return cached;
	const estimate = estimateTokens(message);
	cache.messages.set(message, estimate);
	return estimate;
}

function unitEstimate(messages: readonly AgentMessage[], cache: TokenCache): number {
	const cached = cache.units.get(messages);
	if (cached !== undefined) return cached;
	const estimate = messages.reduce((total, message) => total + messageEstimate(message, cache), 0);
	cache.units.set(messages, estimate);
	return estimate;
}

function toolRecoveryReference(message: AgentMessage, history: SelectionHistoryLookup): ToolRecoveryReference | undefined {
	if (message.role !== "toolResult") return undefined;
	const turn = history.recoveryToolTurn(message);
	return turn ? { historyId: turn.id, toolCallId: message.toolCallId, toolName: message.toolName } : undefined;
}

function unreadTrailingExchange(grouped: GroupedContext, history: SelectionHistoryLookup): ToolExchange | undefined {
	if (!grouped.activeTurn) return undefined;
	const exchange = grouped.activeTurn.exchanges.at(-1);
	if (!exchange) return undefined;
	const calls = exchange.assistant.content.filter(isToolCallBlock);
	if (calls.length === 0) return undefined;
	const callIds = calls.map((call) => call.id);
	const turn = history.toolTurn(exchange.assistant);
	if (!turn || !history.isLastItem(turn)) return undefined;
	const rawCallIds = turn.assistantMessage.content.filter(isToolCallBlock).map((call) => call.id);
	const resultIds = exchange.results.map((result) => result.toolCallId);
	const rawResultIds = turn.toolResults.map((result) => result.toolCallId);
	if (rawCallIds.length !== callIds.length || rawResultIds.length !== resultIds.length
		|| rawCallIds.some((id, index) => id !== callIds[index])
		|| rawResultIds.some((id, index) => id !== resultIds[index])) return undefined;
	return exchange;
}

function recoveredProtectedExchange(exchange: ToolExchange, history: SelectionHistoryLookup): ToolExchange {
	const excludedIds = pagingToolCallIds(exchange.assistant, exchange.results);
	const results = exchange.results.map((result) => {
		if (excludedIds.has(result.toolCallId)) {
			return { ...result, content: [{ type: "text" as const, text: [
				"[Context paging recovery — generated by the extension]",
				"This oversized paging-tool result is excluded from recovery.",
				"Use search_history or browse_history to find the original history items instead.",
			].join("\n") }] };
		}
		const reference = toolRecoveryReference(result, history);
		if (!reference) return result;
		const content = [
			"[Context paging recovery — generated by the extension]",
			"This tool result exceeded the active model context window.",
			`Read the exact stored result with read_context_output(${JSON.stringify({
				historyId: reference.historyId,
				source: "toolResult",
				toolCallId: reference.toolCallId,
			})}).`,
		].join("\n");
		return { ...result, content: [{ type: "text" as const, text: content }] };
	});
	return {
		assistant: exchange.assistant,
		results,
		messages: [exchange.assistant, ...results],
	};
}

function error(code: ContextSelectionErrorCode, message: string, residentTokens: number, estimatedTokens: number, budgetTokens: number): ContextSelectionError {
	return new ContextSelectionError(code, message, residentTokens, estimatedTokens, budgetTokens);
}

function validContextTokens(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export type ContextTokenLimits = {
	budgetTokens: number;
	trimToTokens: number;
	modelLimit: number;
};

function scaledTrimTarget(target: number, configuredBudget: number, budgetTokens: number): number {
	if (target >= configuredBudget) return budgetTokens;
	const scaled = Number.isSafeInteger(budgetTokens)
		? Number(BigInt(target) * BigInt(budgetTokens) / BigInt(configuredBudget))
		: Math.floor(target / configuredBudget * budgetTokens);
	return Math.max(1, scaled);
}

/** Validates configured limits and computes their effective model-window values. */
export function contextTokenLimits(
	input: Pick<ContextSelectionInput, "tokenBudget" | "trimToTokens" | "modelContextWindow">,
): ContextTokenLimits {
	if (
		input.modelContextWindow !== undefined
		&& (!Number.isFinite(input.modelContextWindow) || input.modelContextWindow <= 0)
	) {
		throw error("INVALID_MODEL_CONTEXT", "The active model context-window estimate is invalid.", 0, 0, 0);
	}
	if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0) {
		throw error("INVALID_TOKEN_BUDGET", "The token budget must be a positive safe integer.", 0, 0, 0);
	}
	const trimToTokens = input.trimToTokens === undefined
		? defaultTrimToTokens(input.tokenBudget)
		: input.trimToTokens;
	if (!Number.isSafeInteger(trimToTokens) || trimToTokens <= 0) {
		throw error("INVALID_TRIM_TARGET", "The trim target must be a positive safe integer.", 0, 0, 0);
	}
	const budgetTokens = input.modelContextWindow === undefined
		? input.tokenBudget
		: Math.min(input.tokenBudget, input.modelContextWindow);
	return {
		budgetTokens,
		trimToTokens: scaledTrimTarget(trimToTokens, input.tokenBudget, budgetTokens),
		modelLimit: input.modelContextWindow ?? Number.POSITIVE_INFINITY,
	};
}

// Remembered boundaries are resolved in the original validated groups before any exclusion.
function applyCutFrontier(
	grouped: GroupedContext, frontier: ContextCutFrontier, history: SelectionHistoryLookup,
	outgoing: ReadonlyMap<AgentMessage, boolean>,
): GroupedContext | undefined {
	const matches = (messages: readonly AgentMessage[]) => messages.filter((message) => history.matchesCutKey(message, frontier.lastEvicted));
	if (frontier.kind === "prefix" || frontier.kind === "completedTurn") {
		const units = frontier.kind === "prefix" ? grouped.prefixes : grouped.completedTurns;
		const indexes = units.flatMap((unit, index) => matches(unit.messages).map(() => index));
		if (indexes.length !== 1) return undefined;
		return frontier.kind === "prefix"
			? { ...grouped, prefixes: grouped.prefixes.slice(indexes[0]! + 1) }
			: { ...grouped, prefixes: [], completedTurns: grouped.completedTurns.slice(indexes[0]! + 1) };
	}
	// The prefix/completed variant shares a kind union; narrow the partial variant explicitly.
	if (frontier.kind !== "partialTurn") return undefined;
	const candidates: { completedIndex?: number; exchangeIndex?: number; messageIndex?: number }[] = [];
	grouped.completedTurns.forEach((unit, completedIndex) => unit.messages.forEach((message, messageIndex) => {
		if (message.role === "assistant" && history.matchesCutKey(message, frontier.lastEvicted)) candidates.push({ completedIndex, messageIndex });
	}));
	grouped.activeTurn?.exchanges.forEach((exchange, exchangeIndex) => {
		if (history.matchesCutKey(exchange.assistant, frontier.lastEvicted)) candidates.push({ exchangeIndex });
	});
	if (candidates.length !== 1) return undefined;
	const point = candidates[0]!;
	if (point.completedIndex !== undefined) {
		const original = grouped.completedTurns[point.completedIndex]!;
		const flags = original.messages.map((message) => outgoing.get(message) ?? false);
		const request = requestEnvelope(original.messages, 0, flags);
		if (frontier.userHistoryId !== undefined && history.cutKey(request[0]!)?.historyId !== frontier.userHistoryId) return undefined;
		const nextIndex = exchangeAt(original.messages, point.messageIndex!).nextIndex;
		const trailing = original.messages.slice(request.length).filter((message) => outgoing.get(message));
		const remaining = original.messages.slice(nextIndex).filter((message) => !outgoing.get(message));
		const remainder: CompletedTurnUnit = { kind: "completedTurn", messages: [...request, ...remaining, ...trailing], anchorMessages: original.messages };
		return { ...grouped, prefixes: [], completedTurns: [remainder, ...grouped.completedTurns.slice(point.completedIndex + 1)] };
	}
	const active = grouped.activeTurn!;
	if (frontier.userHistoryId !== undefined && history.cutKey(active.request[0]!)?.historyId !== frontier.userHistoryId) return undefined;
	return { prefixes: [], completedTurns: [], activeTurn: { ...active, exchanges: active.exchanges.slice(point.exchangeIndex! + 1) } };
}

type EvictionUnit = {
	kind: "prefix" | "completedTurn" | "partialTurn";
	messages: AgentMessage[];
	anchorMessages: readonly AgentMessage[];
};
type SelectionView = { grouped: GroupedContext; units: EvictionUnit[]; activeStart: number };
type KeyedBoundary = { count: number; frontier: ContextCutFrontier; notice: UserMessage; rawEstimate: number };
type FifoSelection = {
	selection: ContextSelection;
	normalNotice?: UserMessage;
	removedCount: number;
	lastKeyed?: KeyedBoundary;
	lastWasKeyless: boolean;
	cutFailure?: ContextCutFallbackReason;
};

function selectionView(grouped: GroupedContext): SelectionView {
	const units: EvictionUnit[] = [
		...grouped.prefixes.map((unit) => ({ ...unit, anchorMessages: unit.messages })),
		...grouped.completedTurns.map((unit) => ({ ...unit, anchorMessages: unit.anchorMessages ?? unit.messages })),
	];
	const activeStart = units.length;
	for (const exchange of grouped.activeTurn?.exchanges ?? []) units.push({ kind: "partialTurn", messages: exchange.messages, anchorMessages: [exchange.assistant] });
	return { grouped, units, activeStart };
}

function viewMessages(view: SelectionView, count: number, notice?: UserMessage, replacement?: ToolExchange): AgentMessage[] {
	const active = view.grouped.activeTurn;
	const tail = view.units.slice(Math.max(count, view.activeStart));
	return [
		...(notice ? [{ ...notice }] : []),
		...view.units.slice(count, view.activeStart).flatMap((unit) => unit.messages),
		...(active?.request ?? []),
		...tail.flatMap((unit) => replacement && unit.messages[0] === replacement.assistant ? replacement.messages : unit.messages),
		...(active?.trailingOutgoing ?? []),
	];
}

function unitFrontier(
	unit: EvictionUnit, view: SelectionView, history: SelectionHistoryLookup, outgoing: ReadonlyMap<AgentMessage, boolean>,
): { frontier?: ContextCutFrontier; failed: boolean } {
	for (let index = unit.anchorMessages.length - 1; index >= 0; index--) {
		const message = unit.anchorMessages[index]!;
		if (message.role !== "assistant" && message.role !== "user") continue;
		const key = history.cutKey(message);
		if (!key) {
			if (outgoing.get(message)) continue;
			return { failed: true };
		}
		if (unit.kind !== "partialTurn") return { frontier: { kind: unit.kind, lastEvicted: key }, failed: false };
		const owner = view.grouped.activeTurn!.request.find((request) => request.role === "user");
		const userHistoryId = owner ? history.cutKey(owner)?.historyId : undefined;
		return { frontier: { kind: "partialTurn", lastEvicted: key, ...(userHistoryId ? { userHistoryId } : {}) }, failed: false };
	}
	return { failed: false };
}

function cutSnapshot(frontier: ContextCutFrontier, notice: UserMessage): ContextCutSnapshot {
	return Object.freeze({
		frontier: Object.freeze({ ...frontier, lastEvicted: Object.freeze({ ...frontier.lastEvicted }) }),
		notice: Object.freeze({ ...notice }),
	});
}

// Keep grouping, calibration, notice cost and protected-exchange safety local to this pure selector.
// Raw lookup and cross-call state are separate modules. One FIFO executor serves target advances
// and budget-only fallbacks, so their atomicity and safety rules cannot drift.
export function selectContext(input: ContextSelectionInput): ContextSelection {
	const { budgetTokens, trimToTokens: targetTokens, modelLimit } = contextTokenLimits(input);
	const contextTokens = validContextTokens(input.contextTokens) ? input.contextTokens : undefined;
	const tokenEstimates = contextTokens !== undefined && validTokenEstimates(input.tokenEstimates, input.messages.length)
		? input.tokenEstimates : undefined;
	const residentTokens = tokenEstimates?.residentTokens ?? residentTokenEstimate(input);
	const inputOutgoingOnly = input.outgoingOnly?.length === input.messages.length ? input.outgoingOnly : input.messages.map(() => false);
	const { messages, outgoingOnly } = normalizeInterruptedExchanges(input.messages, inputOutgoingOnly, input.rawHistoryItems);
	const grouped = groupContext(messages, outgoingOnly);
	const outgoing = new Map(messages.map((message, index) => [message, outgoingOnly[index]!]));
	const cache: TokenCache = { messages: new Map(), units: new WeakMap() };
	if (tokenEstimates) {
		for (let index = 0; index < input.messages.length; index++) {
			cache.messages.set(input.messages[index]!, tokenEstimates.messageTokens[index]!);
		}
	}
	const rawInputEstimate = residentTokens + unitEstimate(input.messages, cache);
	const rawFullEstimate = messages === input.messages ? rawInputEstimate : residentTokens + unitEstimate(messages, cache);
	// Never recalibrate after normalization, remembered exclusions, or a backward snap.
	const calibration = contextTokens === undefined ? 0 : contextTokens - rawInputEstimate;
	const calibrated = (estimate: number) => estimate + calibration;
	const reported = (estimate: number) => Math.max(0, calibrated(estimate));
	if (contextTokens === undefined && residentTokens > budgetTokens) {
		throw error("RESIDENT_INPUT_TOO_LARGE", `Resident input estimate ${residentTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, residentTokens, budgetTokens);
	}
	if (!input.cutState && calibrated(rawFullEstimate) <= budgetTokens) {
		return { messages, estimatedTokens: reported(rawFullEstimate), budgetTokens, mode: "within-budget", cutState: undefined };
	}
	const history = new SelectionHistoryLookup(input.rawHistoryItems);
	const rawView = selectionView(grouped);
	const requestTokens = (view: SelectionView) => residentTokens
		+ unitEstimate(view.grouped.activeTurn?.request ?? [], cache)
		+ unitEstimate(view.grouped.activeTurn?.trailingOutgoing ?? [], cache);
	const viewEstimate = (view: SelectionView) => requestTokens(view) + view.units.reduce((total, unit) => total + unitEstimate(unit.messages, cache), 0);
	// Turns that earlier cuts evicted whole; a retained remainder keeps its request object.
	const earlierEvictedTurns = (view: SelectionView) => {
		const retainedRequests = new Set(view.units.filter((unit) => unit.kind === "completedTurn").map((unit) => unit.messages[0]));
		return grouped.completedTurns.filter((unit) => !retainedRequests.has(unit.messages[0]));
	};

	const run = (view: SelectionView, destination: number, previous: ContextCutSnapshot | undefined, stateful: boolean): FifoSelection => {
		let count = 0;
		let retained = viewEstimate(view);
		let notice = previous?.notice;
		let noticeTokens = notice ? messageEstimate(notice, cache) : 0;
		let evictedId = history.recoverableId(previous?.frontier.lastEvicted.historyId);
		let toolReference: ToolRecoveryReference | undefined;
		let noticeKey: string | undefined;
		let lastKeyed: KeyedBoundary | undefined = previous ? { count: 0, frontier: previous.frontier, notice: previous.notice, rawEstimate: retained } : undefined;
		let lastWasKeyless = false;
		let cutFailure: ContextCutFallbackReason | undefined;
		const protectedExchange = unreadTrailingExchange(view.grouped, history);
		const protectedMessages = protectedExchange?.messages;
		const conversation = new EvictedConversation(history);
		for (const unit of earlierEvictedTurns(view)) conversation.addTurn(unit.messages);
		// The copied conversation may use only the room left once every evictable unit is gone,
		// so it never turns a request that fits with the plain notice into an error. A remembered
		// notice was sized for an earlier request, so it is resized before this request overflows.
		const floorTokens = requestTokens(view) + (protectedMessages ? unitEstimate(protectedMessages, cache) : 0);
		const noticeCharacters = Math.max(0, budgetTokens - calibrated(floorTokens)) * 4;
		const finish = (mode: ContextSelectionMode, outgoingNotice = notice, replacement?: ToolExchange): FifoSelection => {
			const replacementDelta = replacement && protectedExchange
				? unitEstimate(replacement.messages, cache) - unitEstimate(protectedExchange.messages, cache) : 0;
			const estimate = retained + replacementDelta + (outgoingNotice ? messageEstimate(outgoingNotice, cache) : 0);
			return { selection: { messages: viewMessages(view, count, outgoingNotice, replacement), estimatedTokens: reported(estimate), budgetTokens, mode, cutState: undefined },
				normalNotice: notice, removedCount: count, lastKeyed, lastWasKeyless, cutFailure };
		};
		if (calibrated(retained + noticeTokens) <= budgetTokens) return finish(previous ? "paged" : "within-budget");
		if (view.grouped.activeTurn && calibrated(requestTokens(view)) > budgetTokens) {
			const estimatedTokens = reported(requestTokens(view));
			throw error("ACTIVE_REQUEST_TOO_LARGE", `Resident plus active request estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
		}
		while (calibrated(retained + noticeTokens) > Math.min(destination, budgetTokens)) {
			const unit = view.units[count];
			if (!unit || unit.messages === protectedMessages) {
				if (count === 0 && previous && calibrated(retained + noticeTokens) > budgetTokens) {
					notice = pagingNotice(budgetTokens, evictedId, toolReference, conversation, noticeCharacters);
					noticeTokens = estimateTokens(notice);
				}
				if (calibrated(retained + noticeTokens) <= budgetTokens) return finish("paged");
				if (protectedExchange) {
					const overflow = protectedOverflowNotice(budgetTokens);
					if (calibrated(retained + messageEstimate(overflow, cache)) <= modelLimit) return finish("protected-overflow", overflow);
					const replacement = recoveredProtectedExchange(protectedExchange, history);
					const recovery = recoveryNotice();
					const recovered = retained + unitEstimate(replacement.messages, cache) - unitEstimate(protectedExchange.messages, cache) + messageEstimate(recovery, cache);
					if (calibrated(recovered) <= modelLimit) return finish("recovery", recovery, replacement);
					const estimatedTokens = reported(recovered);
					throw error("ACTIVE_REQUEST_TOO_LARGE", `Protected exchange recovery estimate ${estimatedTokens} exceeds model context estimate ${input.modelContextWindow}.`, residentTokens, estimatedTokens, budgetTokens);
				}
				const estimatedTokens = reported(retained + noticeTokens);
				const code = view.grouped.activeTurn ? "ACTIVE_REQUEST_TOO_LARGE" : "RESIDENT_INPUT_TOO_LARGE";
				throw error(code, `Resident and retained request estimate ${estimatedTokens} exceeds budget estimate ${budgetTokens}.`, residentTokens, estimatedTokens, budgetTokens);
			}
			count++;
			retained -= unitEstimate(unit.messages, cache);
			for (const message of unit.messages) {
				evictedId = history.recoveryHistoryId(message) ?? evictedId;
				toolReference = toolRecoveryReference(message, history) ?? toolReference;
			}
			const conversationGrew = unit.kind === "completedTurn" && conversation.addTurn(unit.messages);
			const nextNoticeKey = pagingNoticeKey(evictedId, toolReference);
			if (conversationGrew || nextNoticeKey !== noticeKey) {
				notice = pagingNotice(budgetTokens, evictedId, toolReference, conversation, noticeCharacters);
				// Not cached: the cache would keep every rebuilt notice alive until this call ends.
				noticeTokens = estimateTokens(notice);
				noticeKey = nextNoticeKey;
			}
			if (stateful) {
				const anchor = unitFrontier(unit, view, history, outgoing);
				if (anchor.failed) cutFailure ??= "cut-key-unresolved";
				lastWasKeyless = !anchor.frontier;
				if (anchor.frontier) lastKeyed = { count, frontier: anchor.frontier, notice: notice!, rawEstimate: retained };
			}
		}
		return finish("paged");
	};

	const fallback = (reason: ContextCutFallbackReason): ContextSelection => ({
		...run(rawView, budgetTokens, undefined, false).selection, cutState: undefined, cutFallbackReason: reason,
	});
	if (!input.rawHistoryItems) return fallback("raw-history-unavailable");
	const remembered = input.cutState;
	let view = rawView;
	if (remembered) {
		if (!rawCutFrontierResolves(input.rawHistoryItems, remembered.frontier)) return fallback("cut-key-unresolved");
		const retained = applyCutFrontier(grouped, remembered.frontier, history, outgoing);
		if (!retained) return fallback("frontier-not-in-groups");
		view = selectionView(retained);
	}
	const result = run(view, targetTokens, remembered, true);
	if (result.cutFailure) return fallback(result.cutFailure);
	if (result.removedCount === 0) {
		// Keep a resized notice so it stays stable until the cut advances.
		const notice = result.normalNotice;
		const cutState = remembered && notice && notice !== remembered.notice ? cutSnapshot(remembered.frontier, notice) : remembered;
		return { ...result.selection, cutState };
	}
	const boundary = result.lastKeyed;
	if (!boundary) return fallback("keyless-no-key");
	if (result.lastWasKeyless) {
		if (calibrated(boundary.rawEstimate + messageEstimate(boundary.notice, cache)) > budgetTokens) return fallback("keyless-snap-over-budget");
		const snapshot = boundary.count === 0 ? remembered! : cutSnapshot(boundary.frontier, boundary.notice);
		return { messages: viewMessages(view, boundary.count, snapshot.notice), estimatedTokens: reported(boundary.rawEstimate + messageEstimate(snapshot.notice, cache)),
			budgetTokens, mode: "paged", cutState: snapshot };
	}
	return { ...result.selection, cutState: cutSnapshot(boundary.frontier, boundary.notice) };
}
