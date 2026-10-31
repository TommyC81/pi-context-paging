import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ContextSelectionError, selectContext } from "../src/context-policy.ts";
import { appendExchange, completeTurn, fixtureFromEntries, pagingFixture } from "./fixtures/context-cut.ts";

const text = (messages: readonly object[]) => JSON.stringify(messages);
const isPagingNotice = (message: any) => typeof message.content === "string" && message.content.startsWith("[Context paging notice");
// Retention checks ignore the generated notice, which may quote evicted conversation.
const has = (messages: readonly object[], marker: string) => text(messages.filter((message) => !isPagingNotice(message))).includes(marker);
const hasNotice = (messages: readonly object[]) => messages.some(isPagingNotice);
const invalidStructure = (error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE";

test("holds a cut and byte-identical notice below the retained budget", () => {
	const f = pagingFixture("completed");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	assert.ok(first.estimatedTokens <= 80_000);
	assert.ok(has(first.messages, "old-C payload"));
	const next = appendExchange(f, "live-3", 2_000);
	const second = selectContext({ ...next.input, cutState: first.cutState });
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.ok(second.cutState);
	assert.equal(text([second.cutState.notice]), text([first.cutState.notice]));
	assert.deepEqual(second.cutState?.frontier, first.cutState.frontier);
});

test("an omitted target uses the adaptive destination end to end", () => {
	const f = pagingFixture("completed");
	const result = selectContext({ ...f.input, trimToTokens: undefined });
	assert.equal(result.cutState?.frontier.lastEvicted.historyId, "turn-old-B");
	assert.ok(result.estimatedTokens <= 80_000);
	assert.ok(has(result.messages, "old-C payload"));
});

test("does not use the full-history crossing or the target as a new trigger", () => {
	const f = pagingFixture("completed");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const second = selectContext({ ...f.input, contextTokens: 158_001, cutState: first.cutState });
	assert.ok(second.estimatedTokens > 80_000 && second.estimatedTokens <= 128_000);
	assert.deepEqual(second.cutState, first.cutState);
});

test("uses budget-only selection and commits no cut when provenance is absent", () => {
	const f = pagingFixture("completed");
	const result = selectContext({ ...f.input, rawHistoryItems: undefined });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "raw-history-unavailable");
	assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
	assert.ok(has(result.messages, "old-B"));
});

test("exactly at budget does not advance", () => {
	const f = pagingFixture("completed");
	const result = selectContext({ ...f.input, contextTokens: 128_000 });
	assert.equal(result.cutState, undefined);
	assert.equal(result.mode, "within-budget");
	assert.deepEqual(result.messages, f.input.messages);
	assert.equal(hasNotice(result.messages), false);
});

test("retained over-budget estimate advances FIFO", () => {
	const f = pagingFixture("completed");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const second = selectContext({ ...f.input, contextTokens: 190_001, cutState: first.cutState });
	assert.ok(second.cutState);
	assert.notDeepEqual(second.cutState.frontier, first.cutState.frontier);
	assert.equal(has(second.messages, "old-C payload"), false);
	assert.ok(second.estimatedTokens <= 128_000);
});

test("prefix units are evicted before completed turns", () => {
	const f = pagingFixture("completed");
	const source = f.entries.find((entry) => entry.id === "turn-old-A")!;
	assert.ok(source.type === "message" && source.message.role === "assistant");
	const prefix = { ...source, id: "prefix-turn", message: { ...source.message,
		content: [{ type: "text" as const, text: `prefix payload ${"x".repeat(120_000)}` }] } };
	const prefixed = fixtureFromEntries([prefix, ...f.entries]);
	const first = selectContext(prefixed.input);
	assert.ok(first.cutState);
	assert.equal(has(first.messages, "old-A payload"), false);
	assert.equal(has(first.messages, "old-B payload"), true);
	assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-old-A");
});

test("prefix-only cut can stop below budget before reaching an impossible target", () => {
	const f = pagingFixture("completed");
	const prefix = fixtureFromEntries([f.entries.find((entry) => entry.id === "turn-old-A")!]);
	const first = selectContext(prefix.input);
	assert.equal(first.cutState?.frontier.kind, "prefix");
	assert.ok(first.estimatedTokens > 80_000 && first.estimatedTokens < 128_000);
	assert.equal(has(first.messages, "old-A payload"), false);
	const second = selectContext({ ...prefix.input, contextTokens: 110_001, cutState: first.cutState });
	assert.deepEqual(second.messages, first.messages);
	assert.deepEqual(second.cutState, first.cutState);
});

test("lower calibration never restores history", () => {
	const f = pagingFixture("completed");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const second = selectContext({ ...f.input, contextTokens: 110_001, cutState: first.cutState });
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(second.messages, first.messages);
	assert.equal(has(second.messages, "old-A payload"), false);
	assert.equal(has(second.messages, "old-B payload"), false);
});

test("completed turns keep a raw anchor behind an outgoing-only suffix", () => {
	const f = pagingFixture("completed");
	const instruction = { role: "user" as const, content: "outgoing-only suffix", timestamp: 0 };
	const messages = [...f.input.messages.slice(0, 2), instruction, ...f.input.messages.slice(2)];
	const input = { ...f.input, messages, trimToTokens: 110_000,
		outgoingOnly: messages.map((_, index) => index === 2) };
	const first = selectContext(input);
	assert.equal(first.cutFallbackReason, undefined);
	assert.ok(first.cutState);
	assert.equal(first.cutState.frontier.kind, "completedTurn");
	assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-old-A");
	assert.equal(has(first.messages, "old-A payload"), false);
	assert.ok(has(first.messages, "old-B payload"));
	assert.ok(has(first.messages, "live request"));

	const second = selectContext({ ...input, contextTokens: 110_001, cutState: first.cutState });
	assert.equal(second.cutFallbackReason, undefined);
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(second.messages, first.messages);
	assert.equal(has(second.messages, "old-A payload"), false);
});

test("scales target with the model window", () => {
	const f = pagingFixture("completed");
	const result = selectContext({ ...f.input, modelContextWindow: 64_000, contextTokens: 80_001 });
	assert.ok(result.cutState);
	assert.equal(has(result.messages, "old-B payload"), false);
	assert.ok(result.estimatedTokens <= 40_000);
});

test("includes the outgoing notice in the target destination", () => {
	const f = pagingFixture("completed");
	const firstTwo = f.input.messages.slice(0, 4).reduce((sum, message) => sum + estimateTokens(message), 0);
	const result = selectContext({ ...f.input, contextTokens: firstTwo + 80_000 });
	assert.ok(result.cutState);
	assert.equal(has(result.messages, "old-C payload"), false);
	assert.ok(result.estimatedTokens <= 80_000);
});

test("explicit high target still retains a sticky cut", () => {
	const f = pagingFixture("completed");
	const first = selectContext({ ...f.input, trimToTokens: 160_000 });
	assert.ok(first.cutState);
	const second = selectContext({ ...f.input, trimToTokens: 160_000, contextTokens: 110_001, cutState: first.cutState });
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(second.messages, first.messages);
	assert.equal(has(second.messages, "old-A payload"), false);
});

// Partial turns must survive completion without rebuilding their evicted exchanges.
for (const kind of ["active", "custom-active"] as const) {
	test(`${kind} keeps its partial cut after completion and later evicts the remainder atomically`, () => {
		const f = pagingFixture(kind);
		const first = selectContext(f.input);
		const point = first.cutState?.frontier;
		assert.ok(point?.kind === "partialTurn");
		assert.equal(point.userHistoryId, kind === "active" ? "user-live" : undefined);
		assert.equal(point.lastEvicted.historyId, "turn-live-2");
		assert.equal(first.cutFallbackReason, undefined);
		const completed = completeTurn(f, "next");
		const second = selectContext({ ...completed.input, cutState: first.cutState });
		assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
		assert.deepEqual(second.cutState, first.cutState);
		const third = selectContext({ ...completed.input, contextTokens: 190_001, cutState: second.cutState });
		assert.equal(has(third.messages, "live request"), false);
		assert.equal(has(third.messages, "live-3 payload"), false);
		assert.ok(has(third.messages, "next request"));
		assert.equal(third.cutState?.frontier.kind, "completedTurn");
		assert.equal(third.cutState?.frontier.lastEvicted.historyId, "turn-live-4");
	});
}

test("custom-only completed remainder keeps its model anchor without subtracting the old answer twice", () => {
	const custom = pagingFixture("custom-active");
	const old = pagingFixture("completed").entries.find((entry) => entry.id === "turn-old-A")!;
	const f = fixtureFromEntries([custom.entries[0]!, { ...old, id: "turn-live-plain" }]);
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	assert.equal(first.cutState.frontier.kind, "partialTurn");
	assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-live-plain");
	assert.equal(has(first.messages, "old-A payload"), false);
	const completed = completeTurn(f, "next");
	const second = selectContext({ ...completed.input, cutState: first.cutState });
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(second.cutState, first.cutState);
	const crossing = completed.input.contextTokens! + 128_001 - second.estimatedTokens;
	const third = selectContext({ ...completed.input, contextTokens: crossing, cutState: second.cutState });
	assert.equal(has(third.messages, "live request"), false);
	assert.equal(has(third.messages, "next request"), true);
	assert.equal(third.cutState?.frontier.kind, "completedTurn");
	assert.equal(third.cutState?.frontier.lastEvicted.historyId, "turn-live-plain");
	assert.equal(third.cutFallbackReason, undefined);
	assert.ok(third.estimatedTokens > 127_000 && third.estimatedTokens <= 128_000);
});

// A keyless endpoint rolls back the actual output, not just its stored key.
test("keyless target endpoint snaps backward and stays byte-identical below budget", () => {
	const f = pagingFixture("keyless");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	assert.equal(first.cutState.frontier.kind, "completedTurn");
	assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-old-A");
	assert.equal(first.cutFallbackReason, undefined);
	assert.ok(first.estimatedTokens > 80_000 && first.estimatedTokens <= 128_000);
	assert.ok(has(first.messages, "old-custom request"));
	assert.equal(has(first.messages, "old-A request"), false);
	assert.deepEqual(first.messages[0], first.cutState.notice);
	const second = selectContext({ ...f.input, contextTokens: 110_001, cutState: first.cutState });
	assert.equal(second.cutFallbackReason, undefined);
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(second.messages, first.messages);
});

test("keyless backward snap over budget uses its own budget-only fallback", () => {
	const f = appendExchange(pagingFixture("keyless"), "live-1", 30_000);
	const result = selectContext({ ...f.input, contextTokens: 145_001 });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "keyless-snap-over-budget");
	assert.equal(result.mode, "paged");
	assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
	assert.equal(has(result.messages, "old-A request"), false);
	assert.equal(has(result.messages, "old-custom request"), false);
	assert.ok(has(result.messages, "live-1 payload"));
});

test("next trigger removes retained keyless units and cannot return an over-budget no-op", () => {
	const f = pagingFixture("keyless");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const crossing = f.input.contextTokens! + 128_001 - first.estimatedTokens;
	const second = selectContext({ ...f.input, contextTokens: crossing, cutState: first.cutState });
	assert.equal(second.cutState, undefined);
	assert.equal(second.cutFallbackReason, "keyless-snap-over-budget");
	assert.equal(second.mode, "paged");
	assert.ok(second.estimatedTokens <= 128_000);
	assert.equal(has(second.messages, "old-custom request"), false);
	assert.equal(has(second.messages, "old-A request"), false);
	assert.ok(has(second.messages, "live request"));
});

test("zero-key prefix reports its own budget-only fallback", () => {
	const f = pagingFixture("keyless");
	const keyless = fixtureFromEntries(f.entries.filter((entry) => ["custom-old-custom", "user-live"].includes(entry.id)));
	const result = selectContext({ ...keyless.input, outgoingOnly: [true, false] });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "keyless-no-key");
	assert.ok(result.estimatedTokens <= 128_000);
	assert.equal(has(result.messages, "old-custom request"), false);
	assert.ok(has(result.messages, "live request"));
});

test("keyless snapped budget check includes the frozen notice cost", () => {
	const f = pagingFixture("keyless");
	const removed = f.input.messages.slice(0, 2).reduce((sum, message) => sum + estimateTokens(message), 0);
	const result = selectContext({ ...f.input, contextTokens: 128_000 + removed });
	assert.equal(result.cutFallbackReason, "keyless-snap-over-budget");
	assert.equal(result.cutState, undefined);
	assert.ok(result.estimatedTokens <= 128_000);
	assert.equal(has(result.messages, "old-custom request"), false);
});

// Stable IDs must resolve through cloned objects, but never through an ambiguous match.
test("independently cloned messages resolve the same cut and normal notice", () => {
	const f = pagingFixture("active");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const second = selectContext({ ...f.input, messages: structuredClone(f.input.messages),
		rawHistoryItems: structuredClone(f.input.rawHistoryItems), cutState: first.cutState });
	assert.deepEqual(second.messages, first.messages);
	assert.deepEqual(second.cutState, first.cutState);
	assert.equal(second.cutFallbackReason, undefined);
});

test("ambiguous cloned exchanges never choose the newest raw tool-call match", () => {
	const f = pagingFixture("active");
	const raw = structuredClone(f.input.rawHistoryItems!).flatMap((item) => item.id === "turn-live-2"
		? [item, { ...structuredClone(item), id: "ambiguous-live-2" }]
		: [item]);
	const result = selectContext({ ...f.input, messages: structuredClone(f.input.messages), rawHistoryItems: raw });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "cut-key-unresolved");
	assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
	assert.ok(has(result.messages, "live-2 payload"));
});

test("multiple same-name tool calls remain one atomic exchange", () => {
	const f = pagingFixture("active");
	const entries = f.entries.flatMap<SessionEntry>((entry) => {
		if (entry.type !== "message") return [entry];
		if (entry.message.role === "assistant") {
			const calls = entry.message.content.filter((block) => block.type === "toolCall");
			return [{ ...entry, message: { ...entry.message, content: [...calls, { ...calls[0]!, id: `${calls[0]!.id}-second` }] } }];
		}
		if (entry.message.role === "toolResult") return [entry, { ...entry, id: `${entry.id}-second`,
			message: { ...entry.message, toolCallId: `${entry.message.toolCallId}-second`, content: [{ type: "text" as const, text: "second small payload" }] } }];
		return [entry];
	});
	const fixture = fixtureFromEntries(entries);
	const first = selectContext(fixture.input);
	assert.ok(first.cutState);
	assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-live-2");
	const models = first.messages.filter((message) => message.role === "assistant");
	const results = first.messages.filter((message) => message.role === "toolResult");
	assert.equal(models.length, 2);
	assert.equal(results.length, 4);
	const retainedCalls = models.flatMap((message) => message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []));
	assert.deepEqual(retainedCalls, ["call-live-3", "call-live-3-second", "call-live-4", "call-live-4-second"]);
});

test("raw frontier absent from incoming groups falls back without throwing", async () => {
	const { ContextCutState } = await import("../src/context-cut.ts");
	const f = pagingFixture("active");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const state = new ContextCutState();
	state.commit(first.cutState);
	assert.equal(state.prepare(f.input.rawHistoryItems), first.cutState);
	const messages = f.input.messages.filter((message) => message.role === "assistant"
		? !message.content.some((block) => block.type === "toolCall" && block.id === "call-live-2")
		: message.role !== "toolResult" || message.toolCallId !== "call-live-2");
	const result = selectContext({ ...f.input, messages, contextTokens: 128_001, cutState: first.cutState });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "frontier-not-in-groups");
	assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
	assert.ok(has(result.messages, "live-3 payload"));
});

test("normalization removes a raw-valid frontier without a provenance error", () => {
	const f = pagingFixture("active");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const messages = f.input.messages.filter((message) => message.role !== "toolResult" || message.toolCallId !== "call-live-2")
		.map((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "call-live-2")
			? { ...message, stopReason: "aborted" as const } : message);
	const result = selectContext({ ...f.input, messages, contextTokens: 150_001, cutState: first.cutState });
	assert.equal(result.cutState, undefined);
	assert.equal(result.cutFallbackReason, "frontier-not-in-groups");
	assert.ok(has(result.messages, "live-3 payload"));
});

test("cut-state preparation resets missing or non-unique keys and restarts empty", async () => {
	const { ContextCutState } = await import("../src/context-cut.ts");
	const f = pagingFixture("active");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const state = new ContextCutState();
	state.commit(first.cutState);
	assert.equal(state.prepare(f.input.rawHistoryItems), first.cutState);
	const raw = f.input.rawHistoryItems!.filter((item) => item.id !== "turn-live-2");
	assert.equal(state.prepare(raw), undefined);
	state.commit(first.cutState);
	assert.equal(state.prepare(undefined), undefined);
	state.commit(first.cutState);
	state.reset();
	assert.equal(state.prepare(f.input.rawHistoryItems), undefined);
	assert.equal(new ContextCutState().prepare(f.input.rawHistoryItems), undefined);
	state.commit(first.cutState);
	const keyed = f.input.rawHistoryItems!.find((item) => item.id === "turn-live-2")!;
	assert.equal(state.prepare([...f.input.rawHistoryItems!, structuredClone(keyed)]), undefined);
});

test("partial raw preparation requires a model key and checks the user only when present", async () => {
	const { ContextCutState } = await import("../src/context-cut.ts");
	for (const kind of ["active", "custom-active"] as const) {
		const f = pagingFixture(kind);
		const first = selectContext(f.input);
		assert.ok(first.cutState);
		const state = new ContextCutState();
		state.commit(first.cutState);
		assert.equal(state.prepare(f.input.rawHistoryItems), first.cutState);
		if (kind === "active") assert.equal(state.prepare(f.input.rawHistoryItems!.filter((item) => item.id !== "user-live")), undefined);
		state.commit({ ...first.cutState, frontier: { kind: "partialTurn", lastEvicted: { historyId: "user-live" } } });
		assert.equal(state.prepare(f.input.rawHistoryItems), undefined);
	}
});

test("invalid original structure before a remembered cut does not commit a candidate", async () => {
	const { ContextCutState } = await import("../src/context-cut.ts");
	const f = pagingFixture("active");
	const first = selectContext(f.input);
	assert.ok(first.cutState);
	const before = structuredClone(first.cutState);
	const state = new ContextCutState();
	state.commit(first.cutState);
	const orphan = f.input.messages.find((message) => message.role === "toolResult")!;
	assert.throws(() => selectContext({ ...f.input, messages: [orphan, ...f.input.messages], cutState: first.cutState }), invalidStructure);
	const incomplete = f.input.messages.filter((message) => message.role !== "toolResult" || message.toolCallId !== "call-live-1");
	assert.throws(() => selectContext({ ...f.input, messages: incomplete, cutState: first.cutState }), invalidStructure);
	assert.deepEqual(state.prepare(f.input.rawHistoryItems), before);
	assert.deepEqual(first.cutState, before);
});

test("minimum target cannot bypass a fractional model limit", () => {
	assert.throws(() => selectContext({ messages: [], systemPrompt: "", activeTools: [], tokenBudget: 128_000,
		trimToTokens: 80_000, modelContextWindow: 0.5, contextTokens: 0.75, rawHistoryItems: [] }),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "RESIDENT_INPUT_TOO_LARGE");
});

test("an unreachable target below budget is valid", () => {
	const f = pagingFixture("active");
	const result = selectContext({ ...f.input, contextTokens: 180_001 });
	assert.equal(result.mode, "paged");
	assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
	assert.equal(result.cutState?.frontier.lastEvicted.historyId, "turn-live-3");
});

for (const [window, mode] of [[256_000, "protected-overflow"], [128_000, "recovery"]] as const) {
	test(`${mode} preserves the frozen normal notice when normal paging resumes`, () => {
		const f = pagingFixture("active");
		const exceptional = selectContext({ ...f.input, contextTokens: 240_001, modelContextWindow: window });
		assert.equal(exceptional.mode, mode);
		assert.ok(exceptional.cutState);
		const resumed = selectContext({ ...f.input, contextTokens: 180_001, modelContextWindow: window, cutState: exceptional.cutState });
		assert.equal(resumed.mode, "paged");
		assert.deepEqual(resumed.messages[0], exceptional.cutState.notice);
		assert.deepEqual(resumed.cutState?.frontier, exceptional.cutState.frontier);
	});
}
