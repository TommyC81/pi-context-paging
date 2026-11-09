import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { historyItemKeyResolver, MessageCostCache } from "../src/context-costs.ts";
import type { HistoryItem } from "../src/history.ts";

const timestamp = 1;
const entryTimestamp = "2026-11-09T00:00:00.000Z";

const assistant = (callIds: string[]): AssistantMessage => ({ role: "assistant", timestamp,
	content: callIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } })),
	api: "test", provider: "p", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse" });

const result = (callId: string): ToolResultMessage => ({ role: "toolResult", toolCallId: callId, toolName: "read",
	timestamp, isError: false, content: [{ type: "text", text: `${callId} output` }] });

const modelTurn = (id: string, callIds: string[]): HistoryItem => {
	const assistantMessage = assistant(callIds);
	return { id, kind: "modelTurn", sequence: 1, timestamp: entryTimestamp, assistantMessage,
		toolResults: callIds.map((callId) => result(callId)),
		metadata: { tools: ["read"], files: [], failed: false } };
};

test("keyed costs are computed once per key even for fresh message objects", () => {
	const cache = new MessageCostCache();
	let fingerprints = 0;
	let estimates = 0;
	const messageA = result("call-1");
	const messageB = result("call-1");
	assert.equal(cache.fingerprint(messageA, "turn-1#call-1", () => { fingerprints++; return "fp"; }), "fp");
	assert.equal(cache.fingerprint(messageB, "turn-1#call-1", () => { fingerprints++; return "fp"; }), "fp");
	assert.equal(fingerprints, 1);
	assert.equal(cache.estimate(messageA, "turn-1#call-1", () => { estimates++; return 7; }), 7);
	assert.equal(cache.estimate(messageB, "turn-1#call-1", () => { estimates++; return 7; }), 7);
	assert.equal(estimates, 1);
	// A cleared cache recomputes under the same key.
	cache.clear();
	assert.equal(cache.estimate(messageB, "turn-1#call-1", () => { estimates++; return 7; }), 7);
	assert.equal(estimates, 2);
});

test("keyless messages fall back to object identity", () => {
	const cache = new MessageCostCache();
	const message = result("call-1");
	let computes = 0;
	const compute = () => { computes++; return "fp"; };
	assert.equal(cache.fingerprint(message, undefined, compute), "fp");
	assert.equal(cache.fingerprint(message, undefined, compute), "fp");
	assert.equal(computes, 1);
	const rebuilt = result("call-1");
	assert.equal(cache.fingerprint(rebuilt, undefined, compute), "fp");
	assert.equal(computes, 2);
});

test("the resolver binds assistant and tool-result messages to entry-derived keys", () => {
	const items: HistoryItem[] = [
		{ id: "user-1", kind: "user", sequence: 0, timestamp: entryTimestamp, userMessage: { role: "user", content: "request", timestamp } },
		modelTurn("turn-1", ["call-1a", "call-1b"]),
	];
	const keyFor = historyItemKeyResolver(items);
	assert.equal(keyFor(items[1]!.kind === "modelTurn" ? items[1]!.assistantMessage : assistant([])), "turn-1");
	assert.equal(keyFor(result("call-1a")), "turn-1#call-1a");
	assert.equal(keyFor(result("call-1b")), "turn-1#call-1b");
	assert.equal(keyFor(items[0]!.kind === "user" ? items[0]!.userMessage : result("x")), undefined);
	assert.equal(keyFor(assistant(["call-unknown"])), undefined);
});
