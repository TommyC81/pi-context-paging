import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { projectActiveBranch, projectActiveBranchIncremental } from "../src/history.ts";

const timestamp = "2026-11-09T00:00:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const userEntry = (id: string): SessionEntry => ({ type: "message", id, parentId: null, timestamp,
	message: { role: "user", content: `${id} request`, timestamp: 1 } as UserMessage });

const assistantEntry = (id: string, callIds: string[]): SessionEntry => ({ type: "message", id, parentId: null, timestamp,
	message: { role: "assistant", content: callIds.map((callId) => ({ type: "toolCall", id: callId, name: "read", arguments: { path: `${callId}.txt` } })),
		api: "test", provider: "provider-a", model: "model-a", usage, stopReason: "toolUse", timestamp: 2 } as AssistantMessage });

const resultEntry = (id: string, toolCallId: string): SessionEntry => ({ type: "message", id, parentId: null, timestamp,
	message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: `${toolCallId} output` }], isError: false, timestamp: 3 } as ToolResultMessage });

const exchange = (id: string, calls: string[]): SessionEntry[] => calls.length === 0
	? [assistantEntry(id, [])]
	: [assistantEntry(id, calls), ...calls.map((callId, index) => resultEntry(`${id}-result-${index}`, callId))];

const baseBranch = (): SessionEntry[] => [
	userEntry("user-1"),
	...exchange("turn-1", ["call-1a", "call-1b"]),
	userEntry("user-2"),
	...exchange("turn-2", ["call-2a"]),
];

test("incremental projection matches the cold projection across appends and reuses prefix items", () => {
	const entries = baseBranch();
	const first = projectActiveBranchIncremental(entries);
	assert.deepEqual(first.items, projectActiveBranch(entries));
	assert.deepEqual(first.watermark.items, first.items);

	const appended = [...entries, ...exchange("turn-3", ["call-3a", "call-3b"]), userEntry("user-3")];
	const second = projectActiveBranchIncremental(appended, first.watermark);
	assert.deepEqual(second.items, projectActiveBranch(appended));
	// Prefix items are the same objects, not rebuilt copies.
	assert.equal(second.items[0], first.items[0]);
	assert.equal(second.items.at(-1)!.sequence, second.items.length - 1);
	// Re-projecting with nothing new returns the same items and the same watermark.
	const idle = projectActiveBranchIncremental(appended, second.watermark);
	assert.deepEqual(idle.items, second.items);
	assert.equal(idle.watermark, second.watermark);
});

test("a watermark whose anchor entry no longer matches falls back to the cold projection", () => {
	const first = projectActiveBranchIncremental(baseBranch());
	const otherBranch = [userEntry("user-x"), ...exchange("turn-x", ["call-xa"]), ...exchange("turn-y", ["call-ya"])];
	const switched = projectActiveBranchIncremental(otherBranch, first.watermark);
	assert.deepEqual(switched.items, projectActiveBranch(otherBranch));
	assert.deepEqual(switched.watermark.items, switched.items);
});

test("restore options always take the cold projection", () => {
	const entries = [...baseBranch(), ...exchange("turn-3", ["call-3a"])];
	const first = projectActiveBranchIncremental(baseBranch());
	for (const options of [{ recoverIncomplete: true as const }, { interruptedEntryIds: new Set(["turn-1"]) }]) {
		const restored = projectActiveBranchIncremental(entries, first.watermark, options);
		assert.deepEqual(restored.items, projectActiveBranch(entries, options));
	}
});

test("an incomplete trailing exchange stays outside the watermark until its results arrive", () => {
	const partial = [...baseBranch(), assistantEntry("turn-3", ["call-3a", "call-3b"]), resultEntry("turn-3-result-0", "call-3a")];
	const first = projectActiveBranchIncremental(partial);
	assert.deepEqual(first.items, projectActiveBranch(partial));
	assert.equal(first.items.at(-1)!.id, "turn-2");
	assert.equal(first.watermark.entryIndex, partial.findIndex((entry) => entry.id === "turn-3"));

	const completed = [...partial, resultEntry("turn-3-result-1", "call-3b")];
	const second = projectActiveBranchIncremental(completed, first.watermark);
	assert.deepEqual(second.items, projectActiveBranch(completed));
	assert.equal(second.items.at(-1)!.id, "turn-3");
});
