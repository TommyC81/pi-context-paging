import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { selectContext } from "../src/context-policy.ts";
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
const entry = (id: string, message: AssistantMessage | ToolResultMessage | UserMessage): SessionEntry => ({
	type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00.000Z", message,
});
const nestedRecord = (name = "load_history", status = "ok") => ({
	id: "wrapper-call/1", name, status, arguments: { query: "hidden-wrapper-query" }, durationMs: 1,
});
const provenance = (names: readonly string[] = ["load_history"]) => ({
	complete: true, calls: names.map((name, index) => ({ ...nestedRecord(name), id: `wrapper-call/${index + 1}` })),
});

function wrapperEntries(nestedCalls: unknown, mixed = false, name = "codemode"): SessionEntry[] {
	const wrapped = Object.assign(result("wrapper-call", name, "hidden-wrapper-payload", true), {
		...(nestedCalls === undefined ? {} : { nestedCalls }),
		// Tool-owned previews are not host provenance, even when they resemble it.
		details: { ...provenance(), nestedCalls: provenance() },
	});
	return [
		entry("wrapper-turn", assistant([
			{ type: "thinking", thinking: "private-reasoning" },
			call("wrapper-call", name, { code: "dynamicScript()", path: "hidden-wrapper-path.ts" }),
			{ type: "text", text: "Public task decision" },
			...(mixed ? [call("ordinary-call", "read", { path: "src/app.ts" })] : []),
		])),
		entry("wrapper-result", wrapped),
		...(mixed ? [entry("ordinary-result", result("ordinary-call", "read", "ordinary-evidence"))] : []),
	];
}

function registered(items: readonly HistoryItem[]) {
	const tools: ToolDefinition<any, any, any>[] = [];
	registerContextPagingTools({ registerTool(tool) { tools.push(tool); } } as ExtensionAPI, {
		isEnabled: () => true,
		snapshot: () => ({ allItems: items, navigator: new HistoryNavigator(items) }),
	});
	return (name: string, params: unknown) => tools.find((tool) => tool.name === name)!
		.execute("test-call", params, undefined, undefined, {} as ExtensionContext);
}

for (const name of PAGING_TOOL_NAMES) {
	test(`complete ${name}-only codemode exchanges are unavailable through recovery routes`, async () => {
		const items = projectActiveBranch(wrapperEntries(provenance([name])));
		const before = structuredClone(items);
		const navigator = new HistoryNavigator(items);
		assert.deepEqual(navigator.search({ query: "" }), []);
		assert.deepEqual(navigator.browse({ direction: "forward" }), []);
		assert.throws(() => navigator.load(["wrapper-turn"]), /Unknown history ID/);
		const execute = registered(items);
		for (const [tool, params] of [
			["search_history", { query: "hidden-wrapper-payload", load: true }],
			["browse_history", { direction: "forward" }],
		] as const) {
			const reply = await execute(tool, params);
			assert.deepEqual(JSON.parse((reply.content[0] as { text: string }).text).references, []);
			assert.doesNotMatch(JSON.stringify(reply), /hidden-wrapper/);
		}
		await assert.rejects(() => execute("load_history", { historyIds: ["wrapper-turn"] }), /Unknown history ID/);
		for (const selector of [
			{ source: "assistant" as const, contentIndex: 1 },
			{ source: "toolResult" as const, toolCallId: "wrapper-call" },
			{ part: "" },
			{ part: "/toolResults/0/content/0", mode: "parts" },
			{ part: "/toolResults/0/content/0", mode: "image" },
		]) {
			await assert.rejects(() => execute("read_context_output", { historyId: "wrapper-turn", ...selector }),
				/not public recovery output|Recovery-tool output is not available/i);
		}
		assert.deepEqual(items, before);
	});
}

test("mixed outer turns retain ordinary work, indices and search metadata after excluding a paging-only wrapper", async () => {
	const items = projectActiveBranch(wrapperEntries(provenance(PAGING_TOOL_NAMES), true));
	const before = structuredClone(items);
	const navigator = new HistoryNavigator(items);
	for (const query of ["hidden-wrapper-payload", "hidden-wrapper-query", "hidden-wrapper-path.ts", "dynamicScript"]) {
		assert.deepEqual(navigator.search({ query }), []);
	}
	assert.deepEqual(navigator.search({ query: "", tools: ["codemode"] }), []);
	assert.deepEqual(navigator.search({ query: "", failed: true }), []);
	assert.deepEqual(navigator.search({ query: "", tools: ["read"], files: ["src/app.ts"] })
		.map(reference => reference.historyId), ["wrapper-turn"]);
	const [loaded] = navigator.load(["wrapper-turn"]);
	assert.equal(loaded.kind, "modelTurn");
	if (loaded.kind !== "modelTurn") assert.fail("Expected mixed model turn");
	assert.deepEqual(loaded.assistantMessage.content, [null, null,
		{ type: "text", text: "Public task decision" }, call("ordinary-call", "read", { path: "src/app.ts" })]);
	assert.deepEqual(loaded.toolResults, [result("ordinary-call", "read", "ordinary-evidence")]);
	assert.deepEqual(loaded.metadata, { tools: ["read"], files: ["src/app.ts"], failed: false });
	const execute = registered(items);
	for (const [tool, params] of [
		["search_history", { query: "ordinary-evidence", load: true }],
		["browse_history", { direction: "forward" }],
		["load_history", { historyIds: ["wrapper-turn"] }],
		["read_context_output", { historyId: "wrapper-turn", part: "" }],
	] as const) {
		const text = JSON.stringify(await execute(tool, params));
		assert.match(text, tool === "browse_history" ? /ordinary-call/ : /ordinary-evidence/);
		assert.doesNotMatch(text, /hidden-wrapper|dynamicScript|private-reasoning/);
	}
	assert.match(readContextOutput(items, { historyId: "wrapper-turn", source: "assistant", contentIndex: 3 }).text,
		/ordinary-call/);
	for (const selector of [{ source: "assistant" as const, contentIndex: 1 },
		{ source: "toolResult" as const, toolCallId: "wrapper-call" }, { part: "/assistantMessage/content/1" }]) {
		assert.throws(() => readContextOutput(items, { historyId: "wrapper-turn", ...selector }),
			/not public recovery output|Recovery-tool output is not available|Unknown public recovery part/i);
	}
	assert.deepEqual(items, before);
});

const retainedCases: [string, unknown][] = [
	["absent host provenance despite matching tool-owned previews", undefined],
	["null provenance", null],
	["string provenance", "load_history"],
	["array provenance", []],
	["incomplete provenance", { ...provenance(), complete: false }],
	["missing completeness", { calls: [nestedRecord()] }],
	["nonboolean completeness", { ...provenance(), complete: "true" }],
	["empty calls", { complete: true, calls: [] }],
	["missing calls", { complete: true }],
	["nonarray calls", { complete: true, calls: { first: nestedRecord() } }],
	["null call", { complete: true, calls: [null] }],
	["string call", { complete: true, calls: ["load_history"] }],
	["array call", { complete: true, calls: [[]] }],
	["missing call name", { complete: true, calls: [{ id: "wrapper-call/1", status: "ok" }] }],
	["unknown call name", provenance(["future-tool"])],
	["mixed nested calls", provenance(["load_history", "read"])],
	["missing call id", { complete: true, calls: [{ name: "load_history", status: "ok" }] }],
	["empty call id", { complete: true, calls: [{ ...nestedRecord(), id: "" }] }],
	["missing status", { complete: true, calls: [{ id: "wrapper-call/1", name: "load_history" }] }],
	["unknown status", { complete: true, calls: [nestedRecord("load_history", "future-status")] }],
];
for (const [label, record] of retainedCases) {
	test(`wrappers with ${label} remain readable without script classification`, () => {
		const entries = wrapperEntries(record);
		const first = entries[0];
		assert.ok(first.type === "message" && first.message.role === "assistant");
		const block = first.message.content[1];
		assert.ok(block.type === "toolCall");
		block.arguments.code = "text(await tools.load_history({historyIds: ['old']}))";
		const items = projectActiveBranch(entries);
		const before = structuredClone(items);
		const navigator = new HistoryNavigator(items);
		assert.deepEqual(navigator.search({ query: "hidden-wrapper-payload" }).map(reference => reference.historyId), ["wrapper-turn"]);
		const [loaded] = navigator.load(["wrapper-turn"]);
		assert.equal(loaded.kind, "modelTurn");
		if (loaded.kind !== "modelTurn") assert.fail("Expected retained wrapper");
		assert.equal(loaded.assistantMessage.content[1]?.type, "toolCall");
		assert.equal(loaded.toolResults.length, 1);
		assert.match(readContextOutput(items, { historyId: "wrapper-turn", source: "toolResult", toolCallId: "wrapper-call" }).text,
			/hidden-wrapper-payload/);
		assert.deepEqual(items, before);
	});
}

for (const status of ["ok", "error", "unfinished"]) {
	test(`paging-only provenance accepts ${status} calls without optional argument data`, () => {
		const items = projectActiveBranch(wrapperEntries({ complete: true,
			calls: [{ id: "wrapper-call/1", name: "load_history", status }] }));
		assert.deepEqual(new HistoryNavigator(items).browse({ direction: "forward" }), []);
	});
}

test("other wrappers using the same host provenance do not require codemode-specific handling", () => {
	const items = projectActiveBranch(wrapperEntries(provenance(), false, "custom-wrapper"));
	assert.deepEqual(new HistoryNavigator(items).search({ query: "" }), []);
});

function selectionInput(entries: SessionEntry[]) {
	return {
		messages: entries.flatMap(item => item.type === "message" ? [item.message] : []) as any,
		rawHistoryItems: projectActiveBranch(entries),
		systemPrompt: "", activeTools: [], modelContextWindow: 4_000, tokenBudget: 2_000, trimToTokens: 1_000,
	};
}

function oversizedWrapper(mixed = false): SessionEntry[] {
	const entries = wrapperEntries(provenance(), mixed);
	for (const item of entries) {
		if (item.type === "message" && item.message.role === "toolResult") {
			item.message.content = [{ type: "text", text: "x".repeat(24_000) }];
		}
	}
	return entries;
}

test("wrapper-only notices omit unreadable handles without moving the raw frontier or changing frozen notices", () => {
	const input = selectionInput([...oversizedWrapper(),
		entry("active-user", { role: "user", content: "Continue the task", timestamp: 3 })]);
	const before = structuredClone(input);
	const first = selectContext(input);
	assert.equal(first.cutState?.frontier.lastEvicted.historyId, "wrapper-turn");
	const notice = first.messages[0];
	assert.ok(notice.role === "user" && typeof notice.content === "string");
	assert.doesNotMatch(notice.content, /Recent evicted historyId|read_context_output\(\{/);
	const second = selectContext({ ...input, cutState: first.cutState });
	assert.deepEqual(second.messages, first.messages);
	assert.deepEqual(second.cutState, first.cutState);
	assert.deepEqual(input, before);
});

test("unread paging-only wrappers keep the live exchange paired without advertising a recovery handle", () => {
	const input = selectionInput([
		entry("active-user", { role: "user", content: "Continue the task", timestamp: 0 }), ...oversizedWrapper(),
	]);
	const before = structuredClone(input);
	const selection = selectContext(input);
	assert.equal(selection.mode, "recovery");
	assert.ok(selection.estimatedTokens <= 4_000);
	assert.doesNotMatch(JSON.stringify(selection.messages), /read_context_output\(\{/);
	assert.equal(selection.messages.filter(message => message.role === "assistant").length, 1);
	assert.equal(selection.messages.filter(message => message.role === "toolResult").length, 1);
	assert.deepEqual(input, before);
});

for (const emergency of [false, true]) {
	test(`mixed outer-turn ${emergency ? "emergency replacements" : "notices"} advertise only ordinary results`, () => {
		const input = selectionInput([
			entry("active-user", { role: "user", content: "Continue the task", timestamp: 0 }),
			...oversizedWrapper(true),
			...(emergency ? [] : [entry("unread", assistant([call("unread-call", "read")])),
				entry("unread-result", result("unread-call", "read", "Newest unread result"))]),
		]);
		const before = structuredClone(input);
		const selection = selectContext(input);
		assert.equal(selection.mode, emergency ? "recovery" : "paged");
		const text = selection.messages.flatMap(message => {
			if (message.role !== "user" && message.role !== "toolResult") return [];
			return typeof message.content === "string" ? [message.content]
				: message.content.flatMap(block => block.type === "text" ? [block.text] : []);
		}).join("\n");
		assert.match(text, /"toolCallId":"ordinary-call"/);
		assert.doesNotMatch(text, /"toolCallId":"wrapper-call"/);
		for (const match of text.matchAll(/read_context_output\((\{[^\n]+?\})\)/g)) {
			assert.doesNotThrow(() => readContextOutput(input.rawHistoryItems, JSON.parse(match[1])));
		}
		assert.deepEqual(input, before);
	});
}
