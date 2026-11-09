import { performance } from "node:perf_hooks";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { selectContext } from "../src/context-policy.ts";
import { projectActiveBranch, projectActiveBranchIncremental, type HistoryItem, type ProjectionWatermark } from "../src/history.ts";
import { historyItemKeyResolver, MessageCostCache } from "../src/context-costs.ts";

const TURN_COUNT = 300;
const TOOL_OUTPUT_BYTES = 15 * 1024 * 1024;
const TOKEN_BUDGET = 128_000;
const SHORT_TURN_COUNT = 10_000;
const SHORT_TURN_BUDGET = 200_000;
const REQUESTS = 10;

function measure<T>(operation: () => T): { milliseconds: number; value: T } {
	const start = performance.now();
	const value = operation();
	return { milliseconds: performance.now() - start, value };
}

function outputForTurn(turn: number, length: number): string {
	const topic = ["cache", "parser", "history", "navigator", "paging", "needle"][turn % 6]!;
	const block = Array.from({ length: 8 }, (_, line) => {
		const record = `2026-02-25T00:00:${String(line).padStart(2, "0")}Z src/benchmark/turn-${String(turn).padStart(3, "0")}.ts:${String(line * 16).padStart(4, "0")} ${topic} event=read status=ok tokens=128`;
		return `${record.padEnd(127, " ")}\n`;
	}).join("");
	return block.repeat(Math.floor(length / block.length)) + block.slice(0, length % block.length);
}

function sessionEntries(): object[] {
	const entries: object[] = [];
	const outputBytesPerTurn = Math.floor(TOOL_OUTPUT_BYTES / TURN_COUNT);
	const finalOutputBytes = TOOL_OUTPUT_BYTES - outputBytesPerTurn * (TURN_COUNT - 1);
	for (let turn = 0; turn < TURN_COUNT; turn++) {
		const callId = `benchmark-call-${turn}`;
		const timestamp = turn * 3;
		entries.push(
			{ type: "message", id: `benchmark-user-${turn}`, parentId: null, timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content: `Benchmark request ${turn}`, timestamp } },
			{ type: "message", id: `benchmark-turn-${turn}`, parentId: null, timestamp: new Date(timestamp + 1).toISOString(),
				message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${turn}.ts` } }], stopReason: "toolUse", timestamp: timestamp + 1 } },
			{ type: "message", id: `benchmark-result-${turn}`, parentId: null, timestamp: new Date(timestamp + 2).toISOString(),
				message: { role: "toolResult", toolCallId: callId, toolName: "read",
					content: [{ type: "text", text: outputForTurn(turn, turn === TURN_COUNT - 1 ? finalOutputBytes : outputBytesPerTurn) }], isError: false, timestamp: timestamp + 2 } },
		);
	}
	return entries;
}

function shortTurnEntries(): object[] {
	const entries: object[] = [];
	for (let turn = 0; turn < SHORT_TURN_COUNT; turn++) {
		const timestamp = turn * 2;
		entries.push(
			{ type: "message", id: `short-user-${turn}`, parentId: null, timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content: `Short request ${turn} ${"u".repeat(100)}`, timestamp } },
			{ type: "message", id: `short-reply-${turn}`, parentId: null, timestamp: new Date(timestamp + 1).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: `Short reply ${turn} ${"r".repeat(500)}` }], stopReason: "stop", timestamp: timestamp + 1 } },
		);
	}
	return entries;
}

/** Mirrors ContextUsageTracker's stable serialization, which keys no cache across rebuilt objects today. */
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]));
	}
	return value;
}

const messagesOf = (items: readonly HistoryItem[]): AgentMessage[] => items.flatMap((item): AgentMessage[] => item.kind === "user"
	? [item.userMessage]
	: [item.assistantMessage, ...item.toolResults]);

const format = (milliseconds: number) => `${milliseconds.toFixed(2)} ms`;

// Projection: a steady-state request appends one exchange to an already-projected branch.
const grownEntries = [...sessionEntries(),
	{ type: "message", id: "benchmark-turn-appended", parentId: null, timestamp: new Date(TURN_COUNT * 3 + 1).toISOString(),
		message: { role: "assistant", content: [{ type: "toolCall", id: "benchmark-call-appended", name: "read", arguments: { path: "src/appended.ts" } }], stopReason: "toolUse", timestamp: TURN_COUNT * 3 + 1 } },
	{ type: "message", id: "benchmark-result-appended", parentId: null, timestamp: new Date(TURN_COUNT * 3 + 2).toISOString(),
		message: { role: "toolResult", toolCallId: "benchmark-call-appended", toolName: "read",
			content: [{ type: "text", text: outputForTurn(0, 50 * 1024) }], isError: false, timestamp: TURN_COUNT * 3 + 2 } }];

const coldProjection = measure(() => projectActiveBranch(grownEntries as any));
const priorWatermark: ProjectionWatermark = projectActiveBranchIncremental(grownEntries.slice(0, -2) as any).watermark;
const incrementalProjection = measure(() => projectActiveBranchIncremental(grownEntries as any, priorWatermark));
assertSameItems(coldProjection.value, incrementalProjection.value.items);

// Message costs: every request rebuilds projection objects, so identity caches miss every round and keyed caches hit.
const projectionMessages = messagesOf(projectActiveBranch(grownEntries.slice(0, -2) as any)).concat(
	messagesOf(incrementalProjection.value.items).slice(-2));
const oldCosts = measure(() => {
	let tokens = 0;
	for (let request = 0; request < REQUESTS; request++) {
		for (const message of projectionMessages.map((copy) => ({ ...copy }))) {
			JSON.stringify(stableValue(message));
			tokens += estimateTokens(message);
		}
	}
	return tokens / REQUESTS;
});
const costCache = new MessageCostCache();
const newCosts = measure(() => {
	let tokens = 0;
	for (let request = 0; request < REQUESTS; request++) {
		const keyFor = historyItemKeyResolver(incrementalProjection.value.items);
		for (const message of projectionMessages.map((copy) => ({ ...copy }))) {
			const key = keyFor(message);
			costCache.fingerprint(message, key, () => JSON.stringify(stableValue(message)));
			tokens += costCache.estimate(message, key, () => estimateTokens(message));
		}
	}
	return tokens / REQUESTS;
});

// Conversation seeding: a steady-state re-run with a remembered cut rebuilds the evicted conversation.
const shortEntries = shortTurnEntries();
const shortMessages = (shortEntries as any[]).map((entry) => entry.message);
const shortItems = projectActiveBranch(shortEntries as any);
const shortInput = { messages: shortMessages, systemPrompt: "You are a benchmark assistant.", activeTools: [],
	modelContextWindow: SHORT_TURN_BUDGET, tokenBudget: SHORT_TURN_BUDGET, rawHistoryItems: shortItems };
const firstCut = selectContext(shortInput);
const seededRerun = measure(() => selectContext({ ...shortInput, cutState: firstCut.cutState }));
const coldRerun = measure(() => selectContext({ ...shortInput,
	cutState: firstCut.cutState ? { ...firstCut.cutState, conversation: undefined } : undefined }));

console.log(`workload: turns=${TURN_COUNT} entries=${grownEntries.length} requests=${REQUESTS}`);
console.log(`projection cold per request: ${format(coldProjection.milliseconds)} items=${coldProjection.value.length}`);
console.log(`projection incremental per request: ${format(incrementalProjection.milliseconds)} items=${incrementalProjection.value.items.length}`);
console.log(`message costs uncached per request: ${format(oldCosts.milliseconds / REQUESTS)} tokens/request=${oldCosts.value}`);
console.log(`message costs keyed-cache per request: ${format(newCosts.milliseconds / REQUESTS)} tokens/request=${newCosts.value}`);
console.log(`short-turn rerun with conversation seed: ${format(seededRerun.milliseconds)}`);
console.log(`short-turn rerun cold conversation: ${format(coldRerun.milliseconds)}`);

function assertSameItems(cold: readonly HistoryItem[], incremental: readonly HistoryItem[]): void {
	const ids = (items: readonly HistoryItem[]) => items.map((item) => `${item.kind}:${item.id}:${item.sequence}`).join(",");
	if (cold.length !== incremental.length || ids(cold) !== ids(incremental)) {
		throw new Error("incremental projection diverged from the cold projection");
	}
}
