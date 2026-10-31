import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PAGING_TOOL_NAMES, type HistoryItem, type ModelTurnHistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";
import { readContextOutput } from "../src/output-pages.ts";
import { registerContextPagingTools } from "../src/tools.ts";

const publicText = "Public parser decision.\nExact line two.";
const privateValues = [
	"private-reasoning-token",
	"private-thinking-signature",
	"private-redacted-payload",
	"private-text-signature",
	"private-tool-signature",
	"private-unknown-payload",
];

function turn(): ModelTurnHistoryItem {
	return {
		id: "turn-1",
		kind: "modelTurn",
		sequence: 0,
		timestamp: "2026-10-05T00:00:00.000Z",
		assistantMessage: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture-model",
			content: [
				{ type: "thinking", thinking: privateValues[0], thinkingSignature: privateValues[1] },
				{ type: "thinking", thinking: "", thinkingSignature: privateValues[2], redacted: true },
				{ type: "text", text: publicText, textSignature: privateValues[3] },
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/parser.ts", thinking: "application-owned-value" },
					namespace: "fixture-tools",
					thoughtSignature: privateValues[4],
				},
				{ type: "text", text: "Public followup." },
				{ type: "futurePrivateBlock", payload: privateValues[5] } as any,
			],
			usage: {
				input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
		toolResults: [{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "Diagnostic output.\nExact result line." }],
			details: { thinkingSignature: "application-owned-detail" },
			isError: false,
			timestamp: 2,
		}],
		metadata: { tools: ["read"], files: ["src/parser.ts"], failed: false },
	};
}

function assertPublic(value: unknown): void {
	const text = JSON.stringify(value);
	for (const privateValue of privateValues) assert.equal(text.includes(privateValue), false, privateValue);
}

function registered(items: readonly HistoryItem[]) {
	const tools: ToolDefinition<any, any, any>[] = [];
	registerContextPagingTools({ registerTool(tool) { tools.push(tool); } } as ExtensionAPI, {
		isEnabled: () => true,
		snapshot: () => ({ allItems: items, navigator: new HistoryNavigator(items) }),
	});
	return async (name: string, params: unknown) => {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool);
		return tool.execute("fixture-call", params, undefined, undefined, {} as ExtensionContext);
	};
}

test("search does not match private reasoning or provider signatures", () => {
	const navigator = new HistoryNavigator([turn()]);

	for (const query of privateValues) assert.deepEqual(navigator.search({ query }), [], query);
	for (const query of ["parser", "read", "src/parser.ts", "application-owned-value", "Diagnostic"]) {
		assert.deepEqual(navigator.search({ query }).map((reference) => reference.historyId), ["turn-1"], query);
	}
});

test("search and browse previews omit private blocks before public text", () => {
	const navigator = new HistoryNavigator([turn()]);
	const references = [
		...navigator.search({ query: "parser" }),
		...navigator.browse({ direction: "forward" }),
	];

	assert.equal(references.length, 2);
	for (const reference of references) {
		assert.ok(reference.preview.startsWith("Public parser decision. Exact line two."));
		assert.ok(reference.preview.length <= 160);
	}
	assertPublic(references);
});

test("loads preserve public content and original assistant block indices", () => {
	const navigator = new HistoryNavigator([turn()]);
	const loaded = navigator.load(["turn-1"])[0];
	assert.equal(loaded.kind, "modelTurn");
	if (loaded.kind !== "modelTurn") assert.fail("Expected a model turn");

	assert.deepEqual(loaded.assistantMessage.content, [
		null,
		null,
		{ type: "text", text: publicText },
		{
			type: "toolCall", id: "call-1", name: "read",
			arguments: { path: "src/parser.ts", thinking: "application-owned-value" },
			namespace: "fixture-tools",
		},
		{ type: "text", text: "Public followup." },
		null,
	]);
	assertPublic(loaded);
});

test("public recovery leaves raw history and ordinary tool results unchanged", () => {
	const raw = turn();
	const before = structuredClone(raw);
	const user: HistoryItem = {
		id: "user-1", kind: "user", sequence: 1, timestamp: "2026-10-05T00:00:01.000Z",
		userMessage: {
			role: "user", timestamp: 3,
			content: [
				{ type: "text", text: "A user can discuss thinkingSignature literally." },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			],
		},
	};
	const navigator = new HistoryNavigator([raw, user]);
	navigator.search({ query: "parser" });
	navigator.browse({ direction: "forward" });
	const [loaded, loadedUser] = navigator.load(["turn-1", "user-1"]);
	assert.equal(loaded.kind, "modelTurn");
	if (loaded.kind !== "modelTurn") assert.fail("Expected a model turn");
	assert.deepEqual(loaded.toolResults, before.toolResults);
	assert.deepEqual(loadedUser, user);
	readContextOutput([raw], { historyId: raw.id, source: "assistant", contentIndex: 2 });
	assert.deepEqual(raw, before);
});

test("registered recovery tools exclude private data from their replies", async () => {
	const execute = registered([turn()]);
	const cases: Array<[string, unknown]> = [
		["search_history", { query: "parser" }],
		["browse_history", { direction: "forward" }],
		["search_history", { query: "parser", load: true }],
		["load_history", { historyIds: ["turn-1"] }],
		["read_context_output", { historyId: "turn-1", source: "assistant", contentIndex: 2 }],
		["read_context_output", { historyId: "turn-1", source: "assistant", contentIndex: 3 }],
	];

	for (const [name, params] of cases) {
		const result = await execute(name, params);
		assertPublic(result.content);
		assert.equal(result.details, undefined);
	}
	for (const contentIndex of [0, 1, 5]) {
		await assert.rejects(() => execute("read_context_output", {
			historyId: "turn-1", source: "assistant", contentIndex,
		}), /not public recovery output/i);
	}
});

test("output pages reject thinking, redacted thinking, and unknown assistant blocks", () => {
	for (const contentIndex of [0, 1, 5]) {
		assert.throws(() => readContextOutput([turn()], {
			historyId: "turn-1", source: "assistant", contentIndex,
		}), /not public recovery output/i);
	}
});

test("output pages use original indices and exact public text or JSON across offsets", () => {
	const raw = turn();
	let text = "";
	let nextOffset: number | null = 0;
	while (nextOffset !== null) {
		const page = readContextOutput([raw], {
			historyId: raw.id, source: "assistant", contentIndex: 2, offset: nextOffset, limit: 17,
		});
		assert.equal(page.header.part, "/assistantMessage/content/2");
		assert.equal(page.header.format, "text");
		assert.equal(page.header.totalCharacters, publicText.length);
		assert.equal(page.header.offset, text.length);
		text += page.text;
		nextOffset = page.header.nextOffset;
	}
	assert.equal(text, publicText);

	const callPage = readContextOutput([raw], { historyId: raw.id, source: "assistant", contentIndex: 3 });
	assert.equal(callPage.text, JSON.stringify({
		type: "toolCall", id: "call-1", name: "read",
		arguments: { path: "src/parser.ts", thinking: "application-owned-value" },
		namespace: "fixture-tools",
	}));
	assertPublic(callPage);
	const resultPage = readContextOutput([raw], { historyId: raw.id, source: "toolResult", toolCallId: "call-1" });
	assert.equal(resultPage.text, JSON.stringify(raw.toolResults[0]));
});

test("output paging cannot replay private data in legacy recovery-tool results", () => {
	for (const name of PAGING_TOOL_NAMES) {
		const raw = turn();
		raw.assistantMessage.content.push({ type: "toolCall", id: "legacy-call", name, arguments: {} });
		raw.toolResults.push({
			role: "toolResult", toolCallId: "legacy-call", toolName: name,
			content: [{ type: "text", text: JSON.stringify({ items: [turn()] }) }],
			isError: false, timestamp: 3,
		});
		assert.throws(() => readContextOutput([raw], {
			historyId: raw.id, source: "toolResult", toolCallId: "legacy-call",
		}), /Recovery-tool output is not available/i);
		assert.doesNotThrow(() => readContextOutput([raw], {
			historyId: raw.id, source: "toolResult", toolCallId: "call-1",
		}));
	}
});
