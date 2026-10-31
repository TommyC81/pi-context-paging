import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { ContextSelectionError, selectContext } from "../src/context-policy.ts";
import { HistoryProjectionError, projectActiveBranch, type HistoryItem, type ModelTurnHistoryItem } from "../src/history.ts";
import contextPagingExtension from "../src/index.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const assistant = (ids = ["lost-a", "lost-b"], timestamp = 1): AssistantMessage => ({
	role: "assistant", timestamp, api: "anthropic-messages", provider: "fixture", model: "fixture",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	content: [{ type: "text", text: "INTERRUPTED_RECORD" }, ...ids.map((id) => ({
		type: "toolCall" as const, id, name: "bash", arguments: { command: `echo ${id}` },
	}))],
});
const result = (toolCallId: string, text = "ACTUAL_RESULT"): ToolResultMessage => ({
	role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 2,
});
const entry = (id: string, message: AgentMessage) => ({
	type: "message" as const, id, parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message,
});
const select = (messages: AgentMessage[], rawHistoryItems?: HistoryItem[]) => selectContext({
	messages, rawHistoryItems, systemPrompt: "", activeTools: [], tokenBudget: 64_000, modelContextWindow: 64_000,
});
const recoveredItem = (message = assistant(), toolResults: ToolResultMessage[] = []): ModelTurnHistoryItem => ({
	id: "lost-turn", kind: "modelTurn", sequence: 0, timestamp: "2026-10-14T00:00:00.000Z",
	assistantMessage: message, toolResults, metadata: { tools: ["bash", "bash"], files: [], failed: true },
	interruptedByRestore: true,
});

function harness(manager = SessionManager.inMemory()) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let aborts = 0;
	const ctx = {
		sessionManager: manager, hasUI: false, model: { contextWindow: 64_000 },
		getSystemPrompt: () => "", getContextUsage: () => undefined,
		ui: { notify: (message: string) => notifications.push(message) },
		abort: () => { aborts++; },
	};
	contextPagingExtension({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getAllTools: () => [], getActiveTools: () => [],
	} as any, { globalSettings: {}, projectTrusted: false });
	return {
		manager, notifications, aborts: () => aborts,
		emit: async (name: string, event = {}) => await handlers.get(name)?.(event, ctx),
		context: async () => await handlers.get("context")?.({ messages: manager.buildSessionProjection().messages }, ctx) as { messages: AgentMessage[] },
		command: async (action: string) => await commands.get("context-paging").handler(action, ctx),
		search: async () => JSON.parse((await tools.find((tool) => tool.name === "search_history")
			.execute("search", { query: "INTERRUPTED_RECORD", failed: true, load: true }, undefined, undefined, ctx)).content[0].text),
	};
}

// Removing restore classification must break recovery, not merely change a stored flag.
test("restore projection preserves incomplete calls and actual results without rewriting raw messages", () => {
	for (const resultCount of [0, 1]) {
		for (const laterRequest of [false, true]) {
			const entries = [entry("lost-turn", assistant()),
				...[entry("partial-result", result("lost-a"))].slice(0, resultCount),
				...(laterRequest ? [entry("continue", user("CONTINUE"))] : [])];
			const before = structuredClone(entries);
			const items = projectActiveBranch(entries, { recoverIncomplete: true });
			assert.equal(items.length, laterRequest ? 2 : 1, "the incomplete saved exchange must remain recoverable");
			const lost = items[0];
			assert.equal(lost.kind, "modelTurn");
			if (lost.kind !== "modelTurn") throw new Error("Missing recovered turn");
			assert.equal(lost.metadata.failed, true);
			assert.equal(lost.assistantMessage, entries[0].message);
			assert.equal(lost.assistantMessage.stopReason, "toolUse");
			assert.equal(lost.toolResults.length, resultCount);
			assert.deepEqual(entries, before);
			assert.deepEqual(select(entries.map((entry) => entry.message), items).messages,
				laterRequest ? [entries.at(-1)!.message] : []);
		}
	}
});

test("remembered restore IDs do not recover new live incomplete exchanges", () => {
	const entries = [entry("lost-turn", assistant()), entry("continue", user("CONTINUE")),
		entry("live-turn", assistant(["live-call"], 3)), entry("next", user("NEXT"))];
	assert.throws(() => projectActiveBranch(entries, { interruptedEntryIds: new Set(["lost-turn"]) }),
		(error: unknown) => error instanceof HistoryProjectionError && error.code === "INCOMPLETE_TOOL_RESULTS");
});

for (const [label, messages, code] of [
	["duplicate results", [assistant(), result("lost-a"), result("lost-a")], "DUPLICATE_TOOL_RESULT"],
	["mismatched results", [assistant(), result("wrong-call")], "MISMATCHED_TOOL_RESULT"],
	["orphan results", [assistant(), user("NEXT"), result("lost-a")], "ORPHAN_TOOL_RESULT"],
	["duplicate call IDs", [assistant(["lost-a", "lost-a"])], "DUPLICATE_TOOL_CALL"],
] as const) {
	test(`restore projection still rejects ${label}`, () => {
		const entries = messages.map((message, index) => entry(`entry-${index}`, message));
		assert.throws(() => projectActiveBranch(entries, { recoverIncomplete: true }),
			(error: unknown) => error instanceof HistoryProjectionError && error.code === code);
	});
}

test("selection omits cloned restored exchanges but retains the restart prompt", () => {
	const lost = assistant();
	const actual = result("lost-a");
	const messages = structuredClone([lost, actual, user("CONTINUE")]);
	const before = structuredClone(messages);
	assert.deepEqual(select(messages, [recoveredItem(lost, [actual])]).messages, [messages[2]]);
	assert.deepEqual(messages, before);
});

test("selection subtracts recovered exchanges from calibrated estimates", () => {
	const lost = assistant();
	const actual = result("lost-a", "x".repeat(300_000));
	const next = user("CONTINUE");
	const messages = [lost, actual, next];
	const selected = selectContext({ messages, rawHistoryItems: [recoveredItem(lost, [actual])],
		systemPrompt: "", activeTools: [], tokenBudget: 64_000, modelContextWindow: 64_000,
		contextTokens: 90_000, tokenEstimates: { residentTokens: 100, messageTokens: [900, 88_000, 1_000] } });
	assert.deepEqual(selected.messages, [next]);
	assert.equal(selected.estimatedTokens, 1_100);
});

test("a reused call ID in a new live exchange does not inherit restore recovery", () => {
	const lost = assistant(["reused"], 1);
	const live = assistant(["reused"], 3);
	const items: HistoryItem[] = [recoveredItem(lost), { ...recoveredItem(live),
		id: "live-turn", sequence: 1, interruptedByRestore: undefined, metadata: { tools: ["bash"], files: [], failed: false } }];
	assert.throws(() => select(structuredClone([lost, user("CONTINUE"), live, user("NEXT")]), items),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE");
});

test("an identical new live tail cannot reuse the restored exchange's identity", () => {
	const lost = assistant();
	const live = structuredClone(lost);
	// The ordinary raw projection omits this newest live incomplete exchange.
	assert.throws(() => select([lost, user("CONTINUE"), live], [recoveredItem(lost)]),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE");
});

test("ambiguous cloned history is not enough to omit an incomplete exchange", () => {
	const lost = assistant();
	const items: HistoryItem[] = [recoveredItem(lost), { ...recoveredItem(structuredClone(lost)),
		id: "other-turn", interruptedByRestore: undefined, sequence: 1 }];
	assert.throws(() => select(structuredClone([lost, user("CONTINUE")]), items),
		(error: unknown) => error instanceof ContextSelectionError && error.code === "INVALID_MESSAGE_STRUCTURE");
});

for (const reason of ["startup", "resume", "reload", "fork", "new", "tree"]) {
	test(`${reason} recovers saved partial results for requests and history tools without session writes`, async () => {
		const h = harness();
		h.manager.appendMessage(user("ORIGINAL_REQUEST"));
		const lostId = h.manager.appendMessage(assistant());
		h.manager.appendMessage(result("lost-a"));
		h.manager.appendCustomMessageEntry("restart-note", "RESTART_NOTE", true);
		h.manager.appendMessage(user("CONTINUE"));
		const before = structuredClone(h.manager.getEntries());
		await h.emit(reason === "tree" ? "session_tree" : "session_start", { reason });
		const selected = await h.context();
		assert.deepEqual(selected.messages.map((message) => message.role), ["user", "custom", "user"]);
		assert.equal(h.aborts(), 0);
		assert.deepEqual(h.notifications, []);
		const recovered = await h.search();
		assert.deepEqual(recovered.references.map((reference: any) => reference.historyId), [lostId]);
		assert.equal(recovered.items[0].assistantMessage.stopReason, "toolUse");
		assert.equal(recovered.items[0].toolResults[0].content[0].text, "ACTUAL_RESULT");
		assert.deepEqual(h.manager.getEntries(), before);
	});
}

test("a resumed incomplete tail remains recoverable after a new prompt and an enable toggle", async () => {
	const h = harness();
	h.manager.appendMessage(user("ORIGINAL_REQUEST"));
	h.manager.appendMessage(assistant());
	await h.emit("session_start", { reason: "startup" });
	h.manager.appendMessage(user("CONTINUE"));
	await h.command("off");
	await h.command("on");
	assert.deepEqual((await h.context()).messages.map((message) => message.role), ["user", "user"]);
	assert.equal((await h.search()).references.length, 1);
	assert.equal(h.aborts(), 0);
});

test("context and turn-end refreshes do not classify live incomplete calls as crash recovery", async () => {
	const h = harness();
	h.manager.appendMessage(assistant());
	await h.emit("session_start", { reason: "startup" });
	h.manager.appendMessage(user("CONTINUE"));
	const live = assistant(["live-call"], 3);
	h.manager.appendMessage(live);
	h.manager.appendMessage(user("NEXT"));
	await h.emit("turn_end", { message: live });
	await h.context();
	assert.equal(h.aborts(), 1);
	assert.ok(h.notifications.some((text) => text.includes("Canonical tool-call exchange is incomplete")));
});

test("completed saved exchanges remain in outgoing context", async () => {
	const h = harness();
	h.manager.appendMessage(assistant(["complete"]));
	h.manager.appendMessage(result("complete"));
	h.manager.appendMessage(user("CONTINUE"));
	await h.emit("session_start", { reason: "resume" });
	assert.deepEqual((await h.context()).messages.map((message) => message.role), ["assistant", "toolResult", "user"]);
	assert.equal(h.aborts(), 0);
});

test("a recovered exchange whose missing result becomes available is no longer omitted", () => {
	const entries = [entry("lost-turn", assistant(["lost-a"])), entry("late-result", result("lost-a")),
		entry("continue", user("CONTINUE"))];
	const items = projectActiveBranch(entries, { interruptedEntryIds: new Set(["lost-turn"]) });
	assert.deepEqual(select(entries.map((entry) => entry.message), items).messages, entries.map((entry) => entry.message));
});

test("disabled paging leaves a saved incomplete exchange untouched", async () => {
	const h = harness();
	h.manager.appendMessage(assistant());
	h.manager.appendMessage(user("CONTINUE"));
	await h.emit("session_start", { reason: "resume" });
	await h.command("off");
	const before = structuredClone(h.manager.getEntries());
	assert.equal(await h.context(), undefined);
	assert.deepEqual(h.manager.getEntries(), before);
	assert.equal(h.aborts(), 0);
});
