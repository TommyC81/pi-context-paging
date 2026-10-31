import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HistoryItem, ModelTurnHistoryItem, UserHistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";
import { registerContextPagingTools } from "../src/tools.ts";

function user(id: string, content: UserHistoryItem["userMessage"]["content"]): UserHistoryItem {
	return { id, kind: "user", sequence: 0, timestamp: "2026-10-19T00:00:00.000Z",
		userMessage: { role: "user", content, timestamp: 0 } };
}
function turn(text: string): ModelTurnHistoryItem {
	return { id: "turn", kind: "modelTurn", sequence: 0, timestamp: "2026-10-19T00:00:01.000Z",
		assistantMessage: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as any,
		toolResults: [], metadata: { tools: [], files: [], failed: false } };
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
function bounded(reply: any) {
	assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= 16_384, "complete reply exceeds 16 KiB");
	assert.equal(reply.details, undefined);
	return JSON.parse(reply.content[0].text);
}
/** A text page is a JSON header block followed by an unescaped body block. */
function page(reply: any): { header: any; text: string } {
	return { header: bounded(reply), text: reply.content[1]?.text ?? "" };
}
async function collectText(execute: ReturnType<typeof registered>, handle: Record<string, unknown>): Promise<string> {
	let offset = 0;
	let text = "";
	for (let pages = 0; pages < 500; pages++) {
		const { header, text: body } = page(await execute("read_context_output", { ...handle, offset }));
		assert.equal(header.offset, offset);
		text += body;
		if (header.nextOffset === null) { assert.equal(text.length, header.totalCharacters); return text; }
		assert.ok(header.nextOffset > offset, "cursor must advance");
		offset = header.nextOffset;
	}
	assert.fail("too many pages");
}

for (const [label, text] of [["ASCII", "large ".repeat(8_000)], ["Unicode", "😀漢字".repeat(4_000)], ["escaping", '\u0000\\"\n'.repeat(4_000)]] as const) {
	test(`bounds loaded ${label} user content and recovers it exactly through a part handle`, async () => {
		const items = [user("large", text)];
		const before = structuredClone(items);
		const execute = registered(items);
		const payload = bounded(await execute("load_history", { historyIds: ["large"] }));
		const loaded = payload.items[0];
		assert.equal(loaded.id, "large");
		assert.equal(loaded.deferred, true);
		const part = loaded.parts.find((part: any) => part.part === "/userMessage/content");
		assert.ok(part?.read);
		assert.equal(await collectText(execute, part.read), text);
		assert.deepEqual(items, before);
	});
}

test("a huge first item does not prevent a later small item from loading", async () => {
	const items = [user("huge", "x".repeat(100_000)), user("small", "Read this decision")];
	const payload = bounded(await registered(items)("load_history", { historyIds: ["huge", "small"] }));
	assert.deepEqual(payload.items.map((item: any) => item.id), ["huge", "small"]);
	assert.equal(payload.items[0].deferred, true);
	assert.deepEqual(payload.items[1], { ...items[1], sequence: 1 });
});

test("multiple near-limit items share one complete reply budget and all remain retrievable", async () => {
	const items = [user("a", "a".repeat(7_000)), user("b", "b".repeat(7_000)), user("c", "c".repeat(7_000))];
	const execute = registered(items);
	const payload = bounded(await execute("load_history", { historyIds: ["a", "b", "c"] }));
	assert.deepEqual(payload.items.map((item: any) => item.id), ["a", "b", "c"]);
	assert.ok(payload.items.some((item: any) => item.deferred));
	for (const item of payload.items.filter((item: any) => item.deferred)) {
		const manifest = bounded(await execute("read_context_output", item.readParts));
		assert.ok(manifest.parts.some((part: any) => part.part === "/userMessage/content"));
	}
});

test("loaded searches keep all references while deferring oversized bodies and metadata", async () => {
	const items: HistoryItem[] = Array.from({ length: 10 }, (_, i) => user(`u${i}`, "needle ".repeat(2_000)));
	const large = turn("needle");
	large.metadata.files = Array.from({ length: 100 }, (_, i) => `${i}-${"x".repeat(200)}.ts`);
	items.unshift(large);
	const execute = registered(items);
	for (const load of [false, true]) {
		const payload = bounded(await execute("search_history", { query: "", limit: 10, load }));
		assert.equal(payload.references.length, 10);
		assert.equal(new Set(payload.references.map((ref: any) => ref.historyId)).size, 10);
		assert.equal(payload.references[0].historyId, "turn");
		assert.equal(payload.references[0].detailsDeferred, true);
		if (load) {
			assert.equal(payload.items.length, 3);
			assert.equal(payload.unloadedHistoryIds.length, 7);
			assert.ok(payload.items.every((item: any) => item.deferred));
		}
	}
	bounded(await execute("browse_history", { direction: "forward", count: 10 }));
});

test("large tool arguments and details have exact bounded read routes", async () => {
	const item = turn("Public text");
	const args = { command: "repeat ".repeat(5_000) };
	const detail = { transcript: "detail ".repeat(5_000) };
	item.assistantMessage.content.push({ type: "toolCall", id: "call", name: "bash", arguments: args });
	item.toolResults.push({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "Done" }], details: detail, isError: false, timestamp: 2 });
	item.metadata.tools = ["bash"];
	const execute = registered([item]);
	const loaded = bounded(await execute("load_history", { historyIds: ["turn"] })).items[0];
	assert.equal(loaded.deferred, true);
	const callPart = loaded.parts.find((part: any) => part.part === "/assistantMessage/content/1");
	assert.deepEqual(JSON.parse(await collectText(execute, callPart.read)).arguments, args);
	const detailPart = loaded.parts.find((part: any) => part.part === "/toolResults/0/details");
	assert.deepEqual(JSON.parse(await collectText(execute, detailPart.read)), detail);
});

test("application-owned type fields cannot block part-list continuation", async () => {
	const item = turn("Done");
	const details = { type: "application-type-".repeat(2_000), exact: "retained" };
	item.toolResults.push({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Result" }], details, isError: false, timestamp: 2 });
	const execute = registered([item]);
	const loaded = bounded(await execute("load_history", { historyIds: ["turn"] })).items[0];
	const parts = [...loaded.parts];
	let offset = loaded.nextPartOffset;
	while (offset !== null) {
		const page = bounded(await execute("read_context_output", { ...loaded.readParts, offset }));
		parts.push(...page.parts);
		offset = page.nextOffset;
	}
	const part = parts.find((part: any) => part.part === "/toolResults/0/details");
	assert.ok(part?.read);
	assert.deepEqual(JSON.parse(await collectText(execute, part.read)), details);
});

test("large part lists page without losing any public block", async () => {
	const item = turn("first");
	item.assistantMessage.content = Array.from({ length: 160 }, (_, i) => ({ type: "text", text: `Block ${i} ${"x".repeat(100)}` }));
	const execute = registered([item]);
	const loaded = bounded(await execute("load_history", { historyIds: ["turn"] })).items[0];
	assert.equal(loaded.deferred, true);
	assert.ok(loaded.nextPartOffset !== null);
	assert.equal(loaded.readParts.offset, loaded.nextPartOffset, "continuation handle must skip descriptions already returned");
	const parts = [...loaded.parts];
	let offset = loaded.nextPartOffset;
	while (offset !== null) {
		const page = bounded(await execute("read_context_output", { ...loaded.readParts, offset }));
		parts.push(...page.parts);
		if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
		offset = page.nextOffset;
	}
	const pointers = parts.map((part: any) => part.part);
	assert.equal(new Set(pointers).size, loaded.totalParts);
	for (let i = 0; i < 160; i++) assert.ok(pointers.includes(`/assistantMessage/content/${i}`));
});

test("Unicode page cursors never split a surrogate pair and preserve exact text", async () => {
	const item = user("u", "😀".repeat(3_000));
	const execute = registered([item]);
	const handle = { historyId: "u", part: "/userMessage/content", limit: 101 };
	let offset = 0;
	let text = "";
	do {
		const { header, text: body } = page(await execute("read_context_output", { ...handle, offset }));
		assert.ok(!/[\uD800-\uDBFF]$/u.test(body));
		text += body;
		if (header.nextOffset === null) break;
		offset = header.nextOffset;
	} while (true);
	assert.equal(text, item.userMessage.content);
});

for (const source of ["user", "toolResult"] as const) {
	test(`${source} images load as native attachments only after an explicit metadata-handle request`, async () => {
		const data = Buffer.from("image bytes ".repeat(3_000)).toString("base64");
		const image = { type: "image" as const, data, mimeType: "image/png" };
		const item = source === "user" ? user("image", [{ type: "text", text: "Inspect this" }, image]) : turn("Inspect this");
		if (item.kind === "modelTurn") item.toolResults = [{ role: "toolResult", toolCallId: "image-call", toolName: "read", content: [image], isError: false, timestamp: 2 }];
		const items = [item];
		const before = structuredClone(items);
		const execute = registered(items);
		const loadedReply = await execute("load_history", { historyIds: [item.id] });
		const loaded = bounded(loadedReply).items[0];
		assert.doesNotMatch(JSON.stringify(loadedReply), new RegExp(data.slice(0, 200)));
		const descriptor = loaded.parts.find((part: any) => part.type === "image");
		assert.ok(descriptor?.read);
		const attachment = await execute("read_context_output", descriptor.read);
		assert.deepEqual(attachment.content.filter((part: any) => part.type === "image"), [image]);
		assert.ok(Buffer.byteLength(JSON.stringify(attachment), "utf8") > 16_384, "image attachment is exempt from the text cap");
		assert.equal(attachment.details, undefined);
		assert.doesNotMatch(JSON.stringify(attachment.content.filter((part: any) => part.type === "text")), new RegExp(data.slice(0, 200)));
		const textReply = page(await execute("read_context_output", { ...descriptor.read, mode: "text" }));
		assert.doesNotMatch(textReply.text, /"data"/);
		if (source === "toolResult") {
			const text = await collectText(execute, { historyId: item.id, source: "toolResult", toolCallId: "image-call" });
			assert.doesNotMatch(text, /"data"/);
			assert.equal(JSON.parse(text).content[0].read.mode, "image");
		}
		assert.deepEqual(items, before);
	});
}

test("small images also use deferred attachment handles", async () => {
	const data = Buffer.from("distinct image payload".repeat(15)).toString("base64");
	const item = user("image", [{ type: "image", data, mimeType: "image/png" }]);
	const execute = registered([item]);
	const loaded = bounded(await execute("load_history", { historyIds: ["image"] })).items[0];
	assert.equal(loaded.deferred, true);
	assert.equal(loaded.parts[0].read.mode, "image");
});

test("image bytes never appear in history reference previews", async () => {
	const data = Buffer.from("distinct image payload".repeat(15)).toString("base64");
	const execute = registered([user("image", [{ type: "image", data, mimeType: "image/png" }])]);
	const references = bounded(await execute("browse_history", { direction: "forward" }));
	assert.ok(!JSON.stringify(references).includes(data.slice(0, 60)));
});

test("part and image modes cannot bypass private blocks or paging exclusions", async () => {
	const item = turn("public");
	item.assistantMessage.content.unshift({ type: "thinking", thinking: "private" } as any);
	item.assistantMessage.content.push({ type: "toolCall", id: "paging", name: "load_history", arguments: {} });
	item.toolResults.push({ role: "toolResult", toolCallId: "paging", toolName: "load_history", content: [{ type: "image", data: "SElEREVO", mimeType: "image/png" }], isError: false, timestamp: 2 });
	const execute = registered([item]);
	for (const params of [
		{ part: "/assistantMessage/content/0" },
		{ part: "/assistantMessage/content/2" },
		{ part: "/toolResults/0/content/0", mode: "image" },
		{ part: "/assistantMessage/content/1", mode: "image" },
		{ part: "/assistantMessage/content/1", source: "assistant", contentIndex: 1 },
		{ mode: "parts", source: "assistant", contentIndex: 1 },
		{ part: "/assistantMessage/content/1", mode: "unsupported" },
	]) await assert.rejects(() => execute("read_context_output", { historyId: "turn", ...params }));
});
