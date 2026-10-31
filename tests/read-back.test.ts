import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HistoryItem, ModelTurnHistoryItem, UserHistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";
import { registerContextPagingTools } from "../src/tools.ts";

function user(id: string, content: UserHistoryItem["userMessage"]["content"], sequence = 0): UserHistoryItem {
	return { id, kind: "user", sequence, timestamp: "2026-10-31T00:00:00.000Z",
		userMessage: { role: "user", content, timestamp: 0 } };
}

function turn(id: string, content: unknown[], results: unknown[] = []): ModelTurnHistoryItem {
	return { id, kind: "modelTurn", sequence: 0, timestamp: "2026-10-31T00:00:01.000Z",
		assistantMessage: { role: "assistant", content, stopReason: "toolUse", timestamp: 1 } as any,
		toolResults: results as any, metadata: { tools: [], files: [], failed: false } };
}

function toolResult(toolCallId: string, toolName: string, text: string) {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

function registered(items: HistoryItem[]) {
	const tools: ToolDefinition<any, any, any>[] = [];
	const navigator = new HistoryNavigator(items);
	registerContextPagingTools({ registerTool(tool) { tools.push(tool); } } as ExtensionAPI, {
		isEnabled: () => true, snapshot: () => ({ allItems: items, navigator }),
	});
	return async (name: string, params: unknown): Promise<any> => {
		const tool = tools.find((candidate) => candidate.name === name)!;
		return tool.execute("test-call", params, undefined, undefined, {} as ExtensionContext);
	};
}

/** The model reads only content, so the complete reply must fit and details must not copy it. */
function bounded(reply: any) {
	assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= 16_384, "complete reply exceeds 16 KiB");
	assert.equal(reply.details, undefined);
	return reply;
}

function payload(reply: any) {
	return JSON.parse(bounded(reply).content[0].text);
}

function page(reply: any): { header: any; text: string } {
	bounded(reply);
	assert.ok(reply.content.length <= 2);
	const text = reply.content[1]?.text ?? "";
	if (reply.content[1]) assert.notEqual(text, "", "an empty page has no body block");
	return { header: JSON.parse(reply.content[0].text), text };
}

async function readAll(execute: ReturnType<typeof registered>, handle: Record<string, unknown>) {
	let args: Record<string, unknown> | undefined = handle;
	let text = "";
	let pages = 0;
	let format: string | undefined;
	while (args) {
		const { header, text: body } = page(await execute("read_context_output", args));
		assert.ok(!/[\uD800-\uDBFF]$/u.test(body), "a page must not end inside a surrogate pair");
		assert.equal(header.offset, text.length);
		format ??= header.format;
		text += body;
		pages++;
		assert.ok(pages < 100, "too many pages");
		if (header.nextOffset === null) {
			assert.equal(header.next, undefined);
			assert.equal(text.length, header.totalCharacters);
			args = undefined;
		} else {
			assert.equal(header.next.offset, header.nextOffset);
			args = header.next;
		}
	}
	return { text, pages, format };
}

test("a single item over 4 KiB loads whole when it fits the reply", async () => {
	const item = user("u", "a".repeat(10_000));
	const loaded = payload(await registered([item])("load_history", { historyIds: ["u"] }));
	assert.deepEqual(loaded.items, [item]);
});

test("several items load whole from the smallest while the reply fits, in requested order", async () => {
	const items = [user("a", "a".repeat(7_000), 0), user("b", "b".repeat(3_000), 1), user("c", "c".repeat(7_000), 2)];
	const loaded = payload(await registered(items)("load_history", { historyIds: ["a", "b", "c"] })).items;
	assert.deepEqual(loaded.map((item: any) => item.id), ["a", "b", "c"]);
	assert.deepEqual(loaded[0], items[0]);
	assert.deepEqual(loaded[1], items[1]);
	assert.equal(loaded[2].deferred, true);
	assert.deepEqual(loaded[2].readParts, { historyId: "c", mode: "parts", offset: loaded[2].nextPartOffset ?? 0 });
});

test("strings and text blocks read back as plain text in one page", async () => {
	const text = 'Line one with "quotes" and a \\ backslash.\n'.repeat(120);
	const items = [
		user("u", text),
		turn("t", [{ type: "text", text }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "ls" } }],
			[toolResult("call", "bash", text)]),
	];
	const execute = registered(items);
	for (const [handle, part] of [
		[{ historyId: "u", part: "/userMessage/content" }, "/userMessage/content"],
		[{ historyId: "t", part: "/assistantMessage/content/0" }, "/assistantMessage/content/0"],
		[{ historyId: "t", source: "assistant", contentIndex: 0 }, "/assistantMessage/content/0"],
		[{ historyId: "t", part: "/toolResults/0/content/0" }, "/toolResults/0/content/0"],
	] as const) {
		const { header, text: body } = page(await execute("read_context_output", handle));
		assert.deepEqual(header, { historyId: handle.historyId, part, format: "text", offset: 0, nextOffset: null, totalCharacters: text.length });
		assert.equal(body, text);
	}
});

test("other parts read as exact JSON in their own text block", async () => {
	const call = { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo \"hi\"" } };
	const result = toolResult("call", "bash", "hi\n");
	const execute = registered([turn("t", [{ type: "text", text: "Running it." }, call], [result])]);
	const block = page(await execute("read_context_output", { historyId: "t", part: "/assistantMessage/content/1" }));
	assert.equal(block.header.format, "json");
	assert.deepEqual(JSON.parse(block.text), call);
	const output = page(await execute("read_context_output", { historyId: "t", source: "toolResult", toolCallId: "call" }));
	assert.equal(output.header.part, "/toolResults/0");
	assert.equal(output.header.format, "json");
	assert.deepEqual(JSON.parse(output.text), result);
});

test("pages fill the byte budget instead of stopping at 2,000 characters", async () => {
	const text = "0123456789".repeat(4_000);
	const execute = registered([user("u", text)]);
	const first = page(await execute("read_context_output", { historyId: "u", part: "/userMessage/content" }));
	assert.ok(first.text.length > 15_000, `page held only ${first.text.length} characters`);
	const all = await readAll(execute, { historyId: "u", part: "/userMessage/content" });
	assert.equal(all.text, text);
	assert.equal(all.pages, 3);

	const limited = page(await execute("read_context_output", { historyId: "u", part: "/userMessage/content", limit: 5_000 }));
	assert.equal(limited.text, text.slice(0, 5_000));
	assert.deepEqual(limited.header.next, { historyId: "u", part: "/userMessage/content", offset: 5_000, limit: 5_000 });
	await assert.rejects(() => execute("read_context_output", { historyId: "u", part: "/userMessage/content", limit: 16_385 }));
});

for (const [label, text] of [
	["ASCII", "large ".repeat(8_000)],
	["Unicode", "😀漢字".repeat(4_000)],
	["escaping", '\u0000\\"\n'.repeat(4_000)],
] as const) {
	test(`next handles recover ${label} text exactly`, async () => {
		const items = [user("u", text)];
		const before = structuredClone(items);
		const execute = registered(items);
		const all = await readAll(execute, { historyId: "u", part: "/userMessage/content" });
		assert.equal(all.format, "text");
		assert.equal(all.text, text);
		assert.deepEqual(items, before);
	});
}

test("an empty string page has a header and no body block", async () => {
	const reply = await registered([user("u", "")])("read_context_output", { historyId: "u", part: "/userMessage/content" });
	assert.equal(bounded(reply).content.length, 1);
	assert.deepEqual(JSON.parse(reply.content[0].text), {
		historyId: "u", part: "/userMessage/content", format: "text", offset: 0, nextOffset: null, totalCharacters: 0,
	});
});

test("source selectors default to the only public text block or tool result", async () => {
	const execute = registered([turn("t", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "The answer." },
		{ type: "toolCall", id: "call", name: "bash", arguments: {} },
	], [toolResult("call", "bash", "output")])]);
	const assistant = page(await execute("read_context_output", { historyId: "t", source: "assistant" }));
	assert.equal(assistant.header.part, "/assistantMessage/content/1");
	assert.equal(assistant.text, "The answer.");
	const output = page(await execute("read_context_output", { historyId: "t", source: "toolResult" }));
	assert.equal(output.header.part, "/toolResults/0");
	assert.equal(JSON.parse(output.text).content[0].text, "output");
});

test("an assistant source without text blocks defaults to its only public block", async () => {
	const call = { type: "toolCall", id: "call", name: "write", arguments: { path: "notes.md", content: "Decision" } };
	const execute = registered([turn("t", [{ type: "thinking", thinking: "private" }, call])]);
	const { header, text } = page(await execute("read_context_output", { historyId: "t", source: "assistant" }));
	assert.equal(header.part, "/assistantMessage/content/1");
	assert.equal(header.format, "json");
	assert.deepEqual(JSON.parse(text), call);
});

test("ambiguous source selectors list the public choices", async () => {
	const execute = registered([turn("t", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "First." },
		{ type: "text", text: "Second." },
		{ type: "toolCall", id: "call-a", name: "bash", arguments: {} },
		{ type: "toolCall", id: "call-b", name: "read", arguments: {} },
	], [toolResult("call-a", "bash", "a"), toolResult("call-b", "read", "b")])]);
	await assert.rejects(() => execute("read_context_output", { historyId: "t", source: "assistant" }),
		/contentIndex.*1 \(text\), 2 \(text\), 3 \(toolCall\), 4 \(toolCall\)/);
	await assert.rejects(() => execute("read_context_output", { historyId: "t", source: "toolResult" }),
		/toolCallId.*call-a \(bash\), call-b \(read\)/);
});

test("unknown or private parts list the public part pointers", async () => {
	const execute = registered([turn("t", [
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "Public." },
	])]);
	for (const part of ["/assistantMessage/content/0", "/assistantMessage/content/7"]) {
		await assert.rejects(() => execute("read_context_output", { historyId: "t", part }), (error: Error) => {
			assert.match(error.message, /Unknown public recovery part/);
			assert.match(error.message, /"\/assistantMessage\/content\/1"/);
			assert.match(error.message, /mode "parts"/);
			assert.doesNotMatch(error.message, /private/);
			return true;
		});
	}
});

test("part descriptions of text parts report plain-text size and preview", async () => {
	const text = "Plain preview text. ".repeat(1_500);
	const loaded = payload(await registered([user("u", text)])("load_history", { historyIds: ["u"] })).items[0];
	assert.equal(loaded.deferred, true);
	const description = loaded.parts.find((part: any) => part.part === "/userMessage/content");
	assert.equal(description.type, "text");
	assert.equal(description.bytes, Buffer.byteLength(text, "utf8"));
	assert.equal(description.preview, text.slice(0, 160));
});

test("part lists accept every limit the schema allows", async () => {
	const execute = registered([user("u", "short")]);
	const listed = payload(await execute("read_context_output", { historyId: "u", mode: "parts", limit: 16_384 }));
	assert.deepEqual(listed.parts.map((part: any) => part.part), ["/userMessage/content", ""]);
});

/** Bytes of the reply that would carry `body` under `header`, following the documented reply shape. */
function replyBytes(header: any, body: string): number {
	const texts = body === "" ? [JSON.stringify(header)] : [JSON.stringify(header), body];
	return Buffer.byteLength(JSON.stringify({ content: texts.map((text) => ({ type: "text", text })) }), "utf8");
}

test("pages end at the largest character boundary that fits", async () => {
	for (let padding = 0; padding < 40; padding++) {
		const text = "a".repeat(padding) + "😀".repeat(6_000);
		const execute = registered([user("u", text)]);
		const { header, text: body } = page(await execute("read_context_output", { historyId: "u", part: "/userMessage/content" }));
		assert.ok(header.nextOffset >= padding);
		const longer = header.nextOffset + 2;
		const grown = { ...header, nextOffset: longer, next: { ...header.next, offset: longer } };
		assert.ok(replyBytes(grown, text.slice(0, longer)) > 16_384, `padding ${padding}: the page could hold one more character`);
		assert.equal(body, text.slice(0, header.nextOffset));
	}
});

test("worst-case pointers at the length limits still read through to the end", async () => {
	const historyId = "\u0001".repeat(128);
	const prefix = "/toolResults/0/details/";
	const key = "\u0001".repeat(512 - prefix.length);
	const value = "\u0002".repeat(60_000);
	const result = { ...toolResult("call", "bash", "output"), details: { [key]: value } };
	const execute = registered([turn(historyId, [{ type: "toolCall", id: "call", name: "bash", arguments: {} }], [result])]);
	const all = await readAll(execute, { historyId, part: prefix + key });
	assert.equal(all.text, value);
});

test("pointers and history IDs over their length limits are rejected", async () => {
	const prefix = "/toolResults/0/details/";
	const key = "k".repeat(513 - prefix.length);
	const result = { ...toolResult("call", "bash", "output"), details: { [key]: "value" } };
	const longId = "h".repeat(129);
	const execute = registered([
		turn("t", [{ type: "toolCall", id: "call", name: "bash", arguments: {} }], [result]),
		user(longId, "text", 1),
	]);
	await assert.rejects(() => execute("read_context_output", { historyId: "t", part: prefix + key }), /part.*512/);
	await assert.rejects(() => execute("read_context_output", { historyId: longId, part: "/userMessage/content" }), /historyId.*128/);
});

test("errors that list or echo long values stay small", async () => {
	const ids = ["a", "b", "c"].map((letter) => letter.repeat(10_000));
	const results = ids.map((id) => toolResult(id, "bash", "output"));
	const execute = registered([turn("t", ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })), results)]);
	for (const params of [
		{ historyId: "t", source: "toolResult" },
		{ historyId: "t", source: "toolResult", toolCallId: "z".repeat(10_000) },
	]) {
		await assert.rejects(() => execute("read_context_output", params), (error: Error) => {
			assert.ok(Buffer.byteLength(JSON.stringify(error.message), "utf8") <= 2_048, `error has ${error.message.length} characters`);
			return true;
		});
	}
	await assert.rejects(() => execute("read_context_output", { historyId: "t", source: "toolResult" }), /aaaa.*mode "parts"/s);
});

test("search and browse replies keep everything in content", async () => {
	const execute = registered([user("u", "needle")]);
	assert.equal(payload(await execute("search_history", { query: "needle" })).references[0].historyId, "u");
	assert.equal(payload(await execute("search_history", { query: "needle", load: true })).items[0].id, "u");
	assert.equal(payload(await execute("browse_history", { direction: "forward" })).references[0].historyId, "u");
});
