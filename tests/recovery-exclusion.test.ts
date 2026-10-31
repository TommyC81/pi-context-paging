import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { selectContext } from "../src/context-policy.ts";
import contextPagingExtension from "../src/index.ts";
import { PAGING_TOOL_NAMES, projectActiveBranch, type HistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";
import { readContextOutput } from "../src/output-pages.ts";
import { registerContextPagingTools } from "../src/tools.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const call = (id: string, name: string, arguments_: ToolCall["arguments"] = {}): ToolCall =>
	({ type: "toolCall", id, name, arguments: arguments_ });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
	content, usage, stopReason: "toolUse", timestamp: 1,
});
const result = (id: string, name: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 2,
});
const user = (): UserMessage => ({ role: "user", content: "Continue the task", timestamp: 0 });
const entry = (id: string, message: AssistantMessage | ToolResultMessage | UserMessage): SessionEntry => ({
	type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00.000Z", message,
});

function mixedEntries(name: string, resultName = name): SessionEntry[] {
	return [
		entry("mixed", assistant([
			{ type: "thinking", thinking: "private-reasoning" },
			call("paging-call", name, { files: ["hidden-history.ts"], query: "hidden-paging-argument" }),
			{ type: "text", text: "Public task decision" },
			call("ordinary-call", "read", { path: "src/app.ts" }),
		])),
		entry("paging-result", result("paging-call", resultName, "hidden-paging-payload", true)),
		entry("ordinary-result", result("ordinary-call", "read", "ordinary-result")),
	];
}

function registered(items: readonly HistoryItem[]) {
	const tools: ToolDefinition<any, any, any>[] = [];
	registerContextPagingTools({ registerTool(tool) { tools.push(tool); } } as ExtensionAPI, {
		isEnabled: () => true,
		snapshot: () => ({ allItems: items, navigator: new HistoryNavigator(items) }),
	});
	return async (name: string, params: unknown) => {
		const tool = tools.find((candidate) => candidate.name === name)!;
		return tool.execute("test-call", params, undefined, undefined, {} as ExtensionContext);
	};
}

for (const name of PAGING_TOOL_NAMES) {
	test(`mixed ${name} turns retain ordinary work without exposing paging content`, async () => {
		const items = projectActiveBranch(mixedEntries(name));
		const before = structuredClone(items);
		const execute = registered(items);
		for (const [tool, params] of [
			["search_history", { query: "ordinary-result", load: true }],
			["browse_history", { direction: "forward" }],
			["load_history", { historyIds: ["mixed"] }],
		] as const) {
			const reply = await execute(tool, params);
			const serialized = JSON.stringify(reply);
			assert.match(serialized, /mixed/);
			assert.doesNotMatch(serialized, /hidden-paging|hidden-history|private-reasoning/);
		}
		const navigator = new HistoryNavigator(items);
		for (const query of ["hidden-paging-payload", "hidden-paging-argument", "hidden-history.ts"]) {
			assert.deepEqual(navigator.search({ query }), []);
		}
		assert.deepEqual(navigator.search({ query: "", tools: [name] }), []);
		assert.deepEqual(navigator.search({ query: "", failed: true }), []);
		assert.deepEqual(navigator.search({ query: "", tools: ["read"], files: ["src/app.ts"] })
			.map((reference) => reference.historyId), ["mixed"]);
		const [loaded] = navigator.load(["mixed"]);
		assert.equal(loaded.kind, "modelTurn");
		if (loaded.kind !== "modelTurn") assert.fail("Expected mixed turn");
		assert.deepEqual(loaded.assistantMessage.content, [null, null,
			{ type: "text", text: "Public task decision" }, call("ordinary-call", "read", { path: "src/app.ts" })]);
		assert.deepEqual(loaded.metadata, { tools: ["read"], files: ["src/app.ts"], failed: false });
		assert.deepEqual(loaded.toolResults, [result("ordinary-call", "read", "ordinary-result")]);
		assert.equal(readContextOutput(items, { historyId: "mixed", source: "assistant", contentIndex: 3 }).text,
			JSON.stringify(call("ordinary-call", "read", { path: "src/app.ts" })));
		assert.throws(() => readContextOutput(items, {
			historyId: "mixed", source: "assistant", contentIndex: 1,
		}), /not public recovery output/i);
		assert.throws(() => readContextOutput(items, {
			historyId: "mixed", source: "toolResult", toolCallId: "paging-call",
		}), /Recovery-tool output is not available/i);
		assert.deepEqual(items, before);
	});

	test(`${name}-only turns are unavailable through every recovery route`, async () => {
		const items = projectActiveBranch([
			entry("paging-only", assistant([{ type: "text", text: "Paging commentary" }, call("paging-call", name)])),
			entry("paging-result", result("paging-call", name, "Paging payload")),
		]);
		const navigator = new HistoryNavigator(items);
		assert.deepEqual(navigator.search({ query: "" }), []);
		assert.deepEqual(navigator.browse({ direction: "forward" }), []);
		assert.throws(() => navigator.load(["paging-only"]), /Unknown history ID/);
		const execute = registered(items);
		for (const contentIndex of [0, 1]) {
			await assert.rejects(() => execute("read_context_output", {
				historyId: "paging-only", source: "assistant", contentIndex,
			}), /not public recovery output/i);
		}
	});
}

for (const [callName, resultName] of [["search_history", "read"], ["read", "search_history"]]) {
	test(`exclusion checks call ${callName} and result ${resultName} names`, () => {
		const items = projectActiveBranch(mixedEntries(callName, resultName));
		const [loaded] = new HistoryNavigator(items).load(["mixed"]);
		assert.equal(loaded.kind, "modelTurn");
		if (loaded.kind !== "modelTurn") assert.fail("Expected mixed turn");
		assert.deepEqual(loaded.metadata, { tools: ["read"], files: ["src/app.ts"], failed: false });
		assert.doesNotMatch(JSON.stringify(loaded), /hidden-paging|hidden-history/);
		assert.throws(() => readContextOutput(items, {
			historyId: "mixed", source: "assistant", contentIndex: 1,
		}), /not public recovery output/i);
	});
}

for (const failure of ["aborted", "error", "restore", "ordinary-result"] as const) {
	test(`mixed turns preserve ${failure} failure status after paging results are omitted`, () => {
		const entries = mixedEntries("search_history");
		const first = entries[0];
		assert.ok(first.type === "message" && first.message.role === "assistant");
		if (failure === "aborted" || failure === "error") first.message.stopReason = failure;
		if (failure === "restore") entries.pop();
		if (failure === "ordinary-result") {
			const last = entries.at(-1)!;
			assert.ok(last.type === "message" && last.message.role === "toolResult");
			last.message.isError = true;
		}
		const navigator = new HistoryNavigator(projectActiveBranch(entries, { recoverIncomplete: true }));
		assert.deepEqual(navigator.search({ query: "Public task decision", failed: true })
			.map((reference) => reference.historyId), ["mixed"]);
	});
}

function selectionInput(entries: SessionEntry[]) {
	return {
		messages: entries.flatMap((item) => item.type === "message" ? [item.message] : []) as any,
		rawHistoryItems: projectActiveBranch(entries),
		systemPrompt: "", activeTools: [], modelContextWindow: 4_000, tokenBudget: 2_000, trimToTokens: 1_000,
	};
}

function assertNoticeReferencesResolve(content: string, items: HistoryItem[]): void {
	const historyId = content.match(/Recent evicted historyId: ("[^"]+")\./)?.[1];
	if (historyId) assert.doesNotThrow(() => new HistoryNavigator(items).load([JSON.parse(historyId)]));
	for (const match of content.matchAll(/read_context_output\((\{[^\n]+?\})\)/g)) {
		assert.doesNotThrow(() => readContextOutput(items, JSON.parse(match[1])));
	}
}

test("notices skip paging turns while the raw eviction boundary and frozen notice stay stable", () => {
	const input = selectionInput([
		entry("active-user", user()),
		entry("original", assistant([call("original-call", "read")])),
		entry("original-result", result("original-call", "read", "Original evidence")),
		entry("paging", assistant([call("paging-call", "load_history")])),
		entry("paging-result", result("paging-call", "load_history", "x".repeat(24_000))),
		entry("unread", assistant([call("unread-call", "read")])),
		entry("unread-result", result("unread-call", "read", "Keep this unread result")),
	]);
	const before = structuredClone(input);
	const first = selectContext(input);
	assert.equal(first.cutState?.frontier.lastEvicted.historyId, "paging");
	const notice = first.messages[0];
	assert.ok(notice.role === "user" && typeof notice.content === "string");
	assert.match(notice.content, /Recent evicted historyId: "original"\./);
	assertNoticeReferencesResolve(notice.content, input.rawHistoryItems);
	const second = selectContext({ ...input, cutState: first.cutState });
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(second.messages, first.messages);
	assert.deepEqual(input, before);
});

test("notices omit handles when excluded history contains only paging activity", () => {
	const input = selectionInput([
		entry("paging", assistant([call("paging-call", "search_history")])),
		entry("paging-result", result("paging-call", "search_history", "x".repeat(24_000))),
		entry("active-user", user()),
	]);
	const selection = selectContext(input);
	assert.equal(selection.cutState?.frontier.lastEvicted.historyId, "paging");
	const notice = selection.messages[0];
	assert.ok(notice.role === "user" && typeof notice.content === "string");
	assert.doesNotMatch(notice.content, /Recent evicted historyId|read_context_output\(\{/);
	assertNoticeReferencesResolve(notice.content, input.rawHistoryItems);
});

test("oversized unread paging results are replaced without advertising rejected output handles", () => {
	const input = selectionInput([
		entry("active-user", user()),
		entry("paging", assistant([call("paging-call", "load_history")])),
		entry("paging-result", result("paging-call", "load_history", "x".repeat(24_000))),
	]);
	const before = structuredClone(input);
	const selection = selectContext(input);
	assert.equal(selection.mode, "recovery");
	assert.ok(selection.estimatedTokens <= 4_000);
	assert.doesNotMatch(JSON.stringify(selection.messages), /read_context_output\(\{/);
	assert.equal(selection.messages.filter((message) => message.role === "toolResult").length, 1);
	assert.equal(selection.messages.filter((message) => message.role === "assistant").length, 1);
	assert.deepEqual(input, before);
});

for (const emergency of [false, true]) {
	test(`mixed-turn ${emergency ? "emergency replacements" : "notices"} advertise only readable ordinary results`, () => {
		const entries = mixedEntries("browse_history");
		for (const item of entries) {
			if (item.type === "message" && item.message.role === "toolResult") {
				item.message.content = [{ type: "text", text: "x".repeat(24_000) }];
			}
		}
		const input = selectionInput([
			entry("active-user", user()), ...entries,
			...(emergency ? [] : [
				entry("unread", assistant([call("unread-call", "read")])),
				entry("unread-result", result("unread-call", "read", "Keep this unread result")),
			]),
		]);
		const before = structuredClone(input);
		const selection = selectContext(input);
		assert.equal(selection.mode, emergency ? "recovery" : "paged");
		const text = selection.messages.flatMap((message) => {
			if (message.role !== "user" && message.role !== "toolResult") return [];
			return typeof message.content === "string" ? [message.content]
				: message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
		}).join("\n");
		assert.match(text, /"toolCallId":"ordinary-call"/);
		assert.doesNotMatch(text, /"toolCallId":"paging-call"/);
		assertNoticeReferencesResolve(text, input.rawHistoryItems);
		assert.deepEqual(input, before);
	});
}

test("live navigation notices ordinary work added in a mixed paging turn", async () => {
	let branch = [entry("active-user", user())];
	const tools: ToolDefinition<any, any, any>[] = [];
	const pi = {
		on() {}, registerCommand() {}, registerTool(tool: ToolDefinition<any, any, any>) { tools.push(tool); },
	};
	contextPagingExtension(pi as unknown as ExtensionAPI, { globalSettings: {}, projectTrusted: false });
	const ctx = { sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({
		messages: branch.flatMap((item) => item.type === "message" ? [item.message] : []),
	}) } } as unknown as ExtensionContext;
	const search = tools.find((tool) => tool.name === "search_history")!;
	await search.execute("first-call", { query: "Continue" }, undefined, undefined, ctx);
	branch = [...branch, ...mixedEntries("search_history")];
	const found = await search.execute("next-call", { query: "ordinary-result" }, undefined, undefined, ctx);
	assert.deepEqual(JSON.parse((found.content[0] as { text: string }).text).references.map((reference: { historyId: string }) => reference.historyId), ["mixed"]);
});
