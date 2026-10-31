import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";
import { readContextOutput } from "../src/output-pages.ts";

const assistantText = "a".repeat(20_000);
const resultText = "b".repeat(20_000);

const turn: ModelTurnHistoryItem = {
	id: "turn-1",
	kind: "modelTurn",
	sequence: 0,
	timestamp: "2026-09-21T00:00:00.000Z",
	assistantMessage: {
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		stopReason: "toolUse",
		timestamp: 1,
	} as any,
	toolResults: [{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: resultText }],
		isError: false,
		timestamp: 2,
	}] as any,
	metadata: { tools: ["read"], files: [], failed: false },
};

const user: HistoryItem = {
	id: "user-1",
	kind: "user",
	sequence: 1,
	timestamp: "2026-09-21T00:00:01.000Z",
	userMessage: { role: "user", content: "request", timestamp: 3 } as any,
};

test("reads exact output pages without replacing large values", () => {
	const first = readContextOutput([turn], {
		historyId: turn.id,
		source: "toolResult",
		toolCallId: "call-1",
		limit: 2_000,
	});

	assert.equal(first.header.offset, 0);
	assert.equal(first.header.format, "json");
	assert.equal(first.text, JSON.stringify(turn.toolResults[0]).slice(0, 2_000));
	assert.equal(first.header.nextOffset, 2_000);
	assert.deepEqual(first.header.next, { historyId: turn.id, part: "/toolResults/0", offset: 2_000, limit: 2_000 });

	const final = readContextOutput([turn], {
		historyId: turn.id,
		source: "toolResult",
		toolCallId: "call-1",
		offset: first.header.totalCharacters,
	});
	assert.equal(final.text, "");
	assert.equal(final.header.nextOffset, null);
	assert.equal(final.header.next, undefined);

	const assistant = readContextOutput([turn], {
		historyId: turn.id,
		source: "assistant",
		contentIndex: 0,
	});
	assert.equal(assistant.header.format, "text");
	assert.equal(assistant.text, assistantText.slice(0, assistant.text.length));
	assert.ok(assistant.text.length > 15_000);
	assert.equal(assistant.header.nextOffset, assistant.text.length);
});

test("rejects invalid context-output references and page bounds", () => {
	const assistantReference = {
		historyId: turn.id,
		source: "assistant" as const,
		contentIndex: 0,
	};
	const resultReference = {
		historyId: turn.id,
		source: "toolResult" as const,
		toolCallId: "call-1",
	};
	const serializedResult = JSON.stringify(turn.toolResults[0]);

	for (const input of [
		{ ...assistantReference, historyId: "missing" },
		{ ...assistantReference, historyId: user.id },
		{ ...assistantReference, contentIndex: 1 },
		{ ...resultReference, toolCallId: "missing" },
		{ ...resultReference, toolCallId: "" },
		{ ...assistantReference, toolCallId: "call-1" },
		{ ...resultReference, contentIndex: 0 },
		{ ...assistantReference, offset: -1 },
		{ ...assistantReference, offset: 0.5 },
		{ ...assistantReference, limit: 0 },
		{ ...assistantReference, limit: 16_385 },
		{ ...resultReference, offset: serializedResult.length + 1 },
	] as unknown[]) {
		assert.throws(() => readContextOutput([turn, user], input as Parameters<typeof readContextOutput>[1]));
	}
});
