import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";
import { registerContextPagingTools } from "../src/tools.ts";

type RegisteredTool = ToolDefinition<any, any, any>;

function user(id: string, sequence: number, content: string): HistoryItem {
	return {
		id,
		kind: "user",
		sequence,
		timestamp: `2026-09-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
		userMessage: { role: "user", content, timestamp: sequence } as any,
	};
}

function turn(id: string, sequence: number, text: string): HistoryItem {
	return {
		id,
		kind: "modelTurn",
		sequence,
		timestamp: `2026-09-21T00:01:${String(sequence).padStart(2, "0")}.000Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: sequence,
		} as any,
		toolResults: [],
		metadata: { tools: [], files: [], failed: false },
	};
}

function registered(items: readonly HistoryItem[], enabled = true) {
	const tools: RegisteredTool[] = [];
	let snapshots = 0;
	const pi: Pick<ExtensionAPI, "registerTool"> = {
		registerTool(tool) { tools.push(tool); },
	};
	registerContextPagingTools(
		pi as ExtensionAPI,
		{
			isEnabled: () => enabled,
			snapshot: () => {
				snapshots++;
				return { allItems: items, navigator: new HistoryNavigator(items) };
			},
		},
	);
	return { tools, snapshotCount: () => snapshots };
}

function tool(tools: readonly RegisteredTool[], name: string): RegisteredTool {
	const found = tools.find((candidate) => candidate.name === name);
	assert.ok(found, `missing ${name}`);
	return found;
}

async function execute(registeredTool: RegisteredTool, params: unknown) {
	return registeredTool.execute("call-1", params, undefined, undefined, {} as ExtensionContext);
}

/** Recovery replies keep their payload in content; details no longer copies it. */
function payloadOf(result: { content: Array<{ type: string; text?: string }>; details?: unknown }): Record<string, unknown> {
	assert.equal(result.details, undefined);
	const block = result.content[0];
	assert.ok(block.type === "text" && typeof block.text === "string");
	return JSON.parse(block.text) as Record<string, unknown>;
}

type SerializedSchema = {
	type?: unknown;
	additionalProperties?: unknown;
	properties: Record<string, unknown>;
};

function serializedSchema(schema: RegisteredTool["parameters"]): SerializedSchema {
	return JSON.parse(JSON.stringify(schema)) as SerializedSchema;
}

function detailItems(details: Record<string, unknown>): HistoryItem[] {
	assert.ok(Array.isArray(details.items));
	return details.items as HistoryItem[];
}

function detailReferences(details: Record<string, unknown>): Array<{ historyId: string }> {
	assert.ok(Array.isArray(details.references));
	return details.references as Array<{ historyId: string }>;
}

test("registers only the four strict recovery-tool schemas", () => {
	const { tools } = registered([user("u1", 0, "alpha")]);

	assert.deepEqual(tools.map((candidate) => candidate.name), [
		"search_history",
		"browse_history",
		"load_history",
		"read_context_output",
	]);
	assert.equal(tools.some((candidate) => candidate.name === "update_task_state"), false);

	for (const candidate of tools) {
		const schema = serializedSchema(candidate.parameters);
		assert.equal(schema.type, "object");
		assert.equal(schema.additionalProperties, false);
	}

	const search = serializedSchema(tool(tools, "search_history").parameters);
	const load = serializedSchema(tool(tools, "load_history").parameters);
	const output = serializedSchema(tool(tools, "read_context_output").parameters);
	assert.deepEqual(search.properties.limit, {
		minimum: 1,
		maximum: 10,
		default: 5,
		type: "integer",
	});
	assert.deepEqual(load.properties.historyIds, {
		minItems: 1,
		maxItems: 3,
		type: "array",
		items: { maxLength: 128, type: "string" },
	});
	const { description, ...limit } = output.properties.limit as Record<string, unknown>;
	assert.deepEqual(limit, { minimum: 1, maximum: 16_384, type: "integer" });
	assert.equal(typeof description, "string");
});

test("executes searches, browsing, and exact loads from one current snapshot", async () => {
	const items = [user("u1", 0, "alpha"), user("u2", 1, "alpha"), user("u3", 2, "alpha")];
	const registration = registered(items);
	const search = tool(registration.tools, "search_history");
	const browse = tool(registration.tools, "browse_history");
	const load = tool(registration.tools, "load_history");

	assert.deepEqual(detailReferences(payloadOf(await execute(search, { query: "alpha" })))
		.map((item: { historyId: string }) => item.historyId), ["u1", "u2", "u3"]);
	assert.deepEqual(detailItems(payloadOf(await execute(search, { query: "alpha", load: true })))
		.map((item: HistoryItem) => item.id), ["u1", "u2", "u3"]);
	assert.deepEqual(detailReferences(payloadOf(await execute(browse, { direction: "forward", count: 2 })))
		.map((item: { historyId: string }) => item.historyId), ["u1", "u2"]);
	assert.deepEqual(detailItems(payloadOf(await execute(load, { historyIds: ["u3", "u1"] })))
		.map((item: HistoryItem) => item.id), ["u3", "u1"]);
	await assert.rejects(() => execute(load, { historyIds: ["u1", "missing"] }), /Unknown history ID missing/);
	assert.equal(registration.snapshotCount(), 5);
});

test("loaded searches expose every requested reference and let callers load a correction beyond the first three", async () => {
	const items = Array.from({ length: 10 }, (_, sequence) => user(`h${sequence}`, sequence, `rollback v${sequence}`));
	const { tools } = registered(items);
	const search = tool(tools, "search_history");
	const result = await execute(search, { query: "rollback", limit: 10, load: true });
	const payload = payloadOf(result);

	assert.deepEqual(detailReferences(payload).map((reference) => reference.historyId),
		["h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9"]);
	assert.deepEqual(detailItems(payload).map((item) => item.id), ["h0", "h1", "h2"]);
	assert.deepEqual(payload.unloadedHistoryIds, ["h3", "h4", "h5", "h6", "h7", "h8", "h9"]);

	const correction = detailItems(payloadOf(await execute(tool(tools, "load_history"), { historyIds: ["h4"] })));
	assert.deepEqual(correction, [items[4]]);
});

test("loaded searches explicitly report no unloaded results when every match fits", async () => {
	const { tools } = registered([user("u1", 0, "alpha"), user("u2", 1, "alpha")]);
	const payload = payloadOf(await execute(tool(tools, "search_history"), { query: "alpha", load: true }));

	assert.deepEqual(detailReferences(payload).map((reference) => reference.historyId), ["u1", "u2"]);
	assert.deepEqual(detailItems(payload).map((item) => item.id), ["u1", "u2"]);
	assert.deepEqual(payload.unloadedHistoryIds, []);
});

test("returns no items when loading a search with no matches", async () => {
	const { tools } = registered([user("u1", 0, "alpha")]);
	const search = tool(tools, "search_history");

	assert.deepEqual(payloadOf(await execute(search, { query: "missing", load: true })), {
		references: [], items: [], unloadedHistoryIds: [],
	});
});

test("defers oversized reference metadata and loads without losing the history ID", async () => {
	const large = turn("large", 0, "needle");
	if (large.kind === "modelTurn") {
		large.metadata.files = Array.from({ length: 50 }, (_, index) => `src/${index}-${"x".repeat(200)}.ts`);
	}
	const { tools } = registered([large]);
	const search = tool(tools, "search_history");
	const browse = tool(tools, "browse_history");
	const load = tool(tools, "load_history");

	for (const [registeredTool, params] of [
		[search, { query: "needle" }],
		[search, { query: "needle", load: true }],
		[browse, { direction: "forward" }],
	] as const) {
		const reply = await execute(registeredTool, params);
		assert.ok(Buffer.byteLength(JSON.stringify(reply), "utf8") <= 16_384);
		assert.equal(detailReferences(payloadOf(reply))[0].historyId, "large");
	}
	const loaded = await execute(load, { historyIds: ["large"] });
	assert.ok(Buffer.byteLength(JSON.stringify(loaded), "utf8") <= 16_384);
	const [whole] = payloadOf(loaded).items as any[];
	assert.equal(whole.id, "large");
	assert.equal(whole.metadata.files.length, 50);
	const page = await execute(tool(tools, "read_context_output"), { historyId: "large", part: "/metadata" });
	assert.equal(payloadOf(page).format, "json");
	assert.ok(page.content[1].type === "text" && page.content[1].text.includes("src/0-"));
});

test("reads exact output pages repeatedly through next handles", async () => {
	const output = turn("turn-1", 0, "a".repeat(3_000));
	const { tools } = registered([output]);
	const read = tool(tools, "read_context_output");

	const first = payloadOf(await execute(read, {
		historyId: "turn-1",
		source: "assistant",
		contentIndex: 0,
		limit: 2_000,
	}));
	assert.deepEqual(first.next, { historyId: "turn-1", part: "/assistantMessage/content/0", offset: 2_000, limit: 2_000 });
	const second = payloadOf(await execute(read, first.next));
	assert.equal(second.offset, 2_000);
	assert.equal(second.nextOffset, null);
	assert.equal(second.next, undefined);
});

test("rejects disabled recovery tools before taking a snapshot", async () => {
	const registration = registered([user("u1", 0, "alpha")], false);
	const inputs: Record<string, unknown> = {
		search_history: { query: "alpha" },
		browse_history: { direction: "forward" },
		load_history: { historyIds: ["u1"] },
		read_context_output: { historyId: "u1", source: "assistant", contentIndex: 0 },
	};
	for (const registeredTool of registration.tools) {
		await assert.rejects(() => execute(registeredTool, inputs[registeredTool.name]), /disabled/i);
	}
	assert.equal(registration.snapshotCount(), 0);
});

test("describes recovery tools and repeated output reads", () => {
	const { tools } = registered([user("u1", 0, "alpha")]);
	for (const name of ["search_history", "browse_history", "load_history", "read_context_output"]) {
		assert.match(tool(tools, name).description, new RegExp(name));
	}
	assert.match(tool(tools, "read_context_output").description, /header has next/);
});
