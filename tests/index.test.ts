import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildSessionProjection, estimateTokens,
	type RegisteredCommand, type SessionBeforeForkEvent, type SessionBeforeSwitchEvent, type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { ContextCutState } from "../src/context-cut.ts";
import { ContextUsageTracker } from "../src/context-usage.ts";
import { fixtureFromEntries, pagingFixture, type PagingFixture } from "./fixtures/context-cut.ts";
import contextPagingExtension, { resolveContextPagingSettings } from "../src/index.ts";
import { HistoryNavigator } from "../src/navigator.ts";

type Handler = (event: any, ctx: any) => unknown;

type Settings = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const custom = (content: string) => ({
	role: "custom" as const,
	customType: "test-request",
	content,
	display: true,
	timestamp: 0,
});
const assistant = (text: string, usage?: object, stopReason = "stop") => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
	usage,
	stopReason,
});
const toolAssistant = (id: string, name = "read") => ({
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id, name, arguments: { path: "src/file.ts" } }],
	timestamp: 0,
});
const result = (toolCallId: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "read",
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 0,
});
const entry = (id: string, message: object) => ({
	id,
	type: "message" as const,
	timestamp: "2026-09-21T00:00:00.000Z",
	message,
});
const branchFor = (reason: string) => [entry(`user-${reason}`, user(reason))];
const marker = (message: any) => typeof message.content === "string"
	? message.content
	: message.content?.map((block: any) => block.text ?? "").join("") ?? "";
const isPagingNotice = (message: object) => marker(message).startsWith("[Context paging notice");
// Retention checks ignore the generated notice, which may quote evicted conversation.
const hasMarker = (messages: readonly object[], value: string) => messages.some((message) => !isPagingNotice(message) && marker(message).includes(value));
const hasNotice = (messages: readonly object[]) => messages.some(isPagingNotice);
const statusTokens = (usage: number, suffix: readonly object[]) =>
	usage + suffix.reduce((sum, message) => sum + estimateTokens(message as any), 0);

function createHarness(settings: Settings | null = { globalSettings: {}, projectTrusted: false }) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const tools: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let branch: any[] = branchFor("initial");
	let branchReads = 0;
	let branchError: Error | undefined;
	let projectedMessages: object[] | undefined;
	let aborts = 0;
	let appends = 0;
	let contextUsage: unknown;
	let activeTools = ["small", "missing"];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
		registerTool(tool: any) { tools.push(tool); },
		appendEntry() { appends++; },
		getActiveTools: () => activeTools,
		getAllTools: () => [
			{ name: "small", description: "small active tool", parameters: { type: "object" } },
			{ name: "large-inactive", description: "x".repeat(300_000), parameters: { type: "object" } },
		],
	};
	const ctx = {
		sessionManager: {
			getBranch: () => {
				branchReads++;
				if (branchError) throw branchError;
				return branch;
			},
			buildSessionProjection: () => ({
				messages: projectedMessages ?? branch.flatMap((item: any) =>
					item.type === "custom_message" ? buildSessionProjection([item]).messages
						: item.type === "message" ? [item.message] : []),
			}),
		},
		getSystemPrompt: () => "system",
		getContextUsage: () => contextUsage,
		isProjectTrusted: () => false,
		model: { contextWindow: 64_000 },
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
		abort: () => { aborts++; },
	};
	contextPagingExtension(pi as any, settings ?? undefined);
	return {
		handlers,
		commands,
		tools,
		ctx,
		notifications,
		branch: () => branch,
		setBranch: (next: any[]) => { branch = next; branchError = undefined; },
		setBranchError: (error: Error) => { branchError = error; },
		setProjectedMessages: (next: object[] | undefined) => { projectedMessages = next; },
		branchReads: () => branchReads,
		resetBranchReads: () => { branchReads = 0; },
		abortCalls: () => aborts,
		appendCalls: () => appends,
		setContextUsage: (next: unknown) => { contextUsage = next; },
		setActiveTools: (next: string[]) => { activeTools = next; },
	};
}

async function emit(harness: ReturnType<typeof createHarness>, name: string, event: any) {
	return await harness.handlers.get(name)?.(event, harness.ctx);
}

async function runPagingCommand(harness: ReturnType<typeof createHarness>, args: string) {
	const command = harness.commands.get("context-paging");
	assert.ok(command, "the context-paging command must be registered");
	await command.handler(args, harness.ctx as any);
}

async function searchIds(harness: ReturnType<typeof createHarness>, query: string) {
	const search = harness.tools.find((tool) => tool.name === "search_history");
	const response = await search.execute("call", { query }, undefined, undefined, harness.ctx);
	return response.details.references.map((reference: { historyId: string }) => reference.historyId);
}

test("resolves enabled setting precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: true,
	}).enabled, true);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: false } },
		projectSettings: { contextPaging: { enabled: true } },
		projectTrusted: false,
	}).enabled, false);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: "yes" } },
		projectTrusted: true,
	}).enabled, true);
});

test("resolves valid token budgets by trusted source precedence", () => {
	assert.equal(resolveContextPagingSettings({
		globalSettings: {},
		projectTrusted: false,
	}).tokenBudget, 128_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: true,
	}).tokenBudget, 72_000);
	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: 72_000 } },
		projectTrusted: false,
	}).tokenBudget, 96_000);
});

test("falls through invalid token budgets without throwing", () => {
	for (const tokenBudget of [
		0,
		-1,
		1.5,
		"128000",
		[],
		{},
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		assert.equal(resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget } },
			projectTrusted: false,
		}).tokenBudget, 128_000);
	}

	assert.equal(resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 96_000 } },
		projectSettings: { contextPaging: { tokenBudget: "invalid" } },
		projectTrusted: true,
	}).tokenBudget, 96_000);
});

test("uses the resolved lower trim target when stable cuts are committed", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { tokenBudget: 128_000, trimToTokens: 80_000 } }, projectTrusted: false,
	});
	harness.ctx.model.contextWindow = 128_000;
	const completed = ["LEGACY_A", "LEGACY_B", "LEGACY_C"].flatMap((label) => [
		user(`${label}_REQUEST ${"x".repeat(120_000)}`),
		assistant(`${label}_ANSWER ${"x".repeat(120_000)}`),
	]);
	const messages = [...completed, user("ACTIVE_REQUEST")];
	harness.setBranch(messages.map((message, index) => entry(`legacy-${index}`, message)));
	const selection = await emit(harness, "context", { type: "context", messages }) as { messages: object[] };

	assert.equal(hasMarker(selection.messages, "LEGACY_A"), false);
	assert.equal(hasMarker(selection.messages, "LEGACY_B"), false);
	assert.equal(hasMarker(selection.messages, "LEGACY_C"), true);
	assert.equal(hasMarker(selection.messages, "ACTIVE_REQUEST"), true);
	assert.equal(harness.abortCalls(), 0);
});

test("registers only paging lifecycle handlers", () => {
	const harness = createHarness();
	assert.equal(harness.tools.length, 4);
	assert.deepEqual([...harness.handlers.keys()].sort(), [
		"context",
		"model_select",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.equal(harness.handlers.has("session_before_tree"), false);
});

test("refreshes navigation history for session lifecycle changes without cancelling tree navigation", async () => {
	const harness = createHarness();
	for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
		harness.setBranch(branchFor(reason));
		harness.resetBranchReads();
		await emit(harness, "session_start", { reason });
		assert.equal(harness.branchReads(), 1);
		assert.deepEqual(await searchIds(harness, reason), [`user-${reason}`]);
	}

	harness.setBranch(branchFor("turn-end"));
	harness.resetBranchReads();
	await emit(harness, "turn_end", {});
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "turn-end"), ["user-turn-end"]);

	harness.setBranch(branchFor("old-tree"));
	harness.resetBranchReads();
	await emit(harness, "session_start", { reason: "startup" });
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "old-tree"), ["user-old-tree"]);
	harness.setBranch(branchFor("tree"));
	harness.resetBranchReads();
	assert.equal(await emit(harness, "session_tree", {}), undefined);
	assert.equal(harness.branchReads(), 1);
	assert.deepEqual(await searchIds(harness, "old-tree"), []);
	assert.deepEqual(await searchIds(harness, "tree"), ["user-tree"]);

	harness.setBranchError(new Error("LIFECYCLE_PROJECTION_FAILURE"));
	harness.resetBranchReads();
	await emit(harness, "turn_end", {});
	assert.equal(harness.branchReads(), 1);
	assert.match(harness.notifications.at(-1)?.message ?? "", /LIFECYCLE_PROJECTION_FAILURE/);
	harness.setBranch(branchFor("after-failure"));
	const canonicalMessages = [user("CANONICAL_AFTER_LIFECYCLE_FAILURE")];
	assert.deepEqual(await emit(harness, "context", { messages: canonicalMessages }), {
		messages: canonicalMessages,
	});
	assert.equal(harness.abortCalls(), 0);
});

test("keeps interrupted exchanges in raw lifecycle history while omitting them from provider context", async () => {
	const harness = createHarness();
	const failed = { ...toolAssistant("failed-call"), stopReason: "aborted" as const };
	const rawBranch = [
		entry("failed-turn", failed),
		entry("next-user", user("continue after interruption")),
	];
	const rawBefore = structuredClone(rawBranch);
	for (const reason of ["startup", "resume"] as const) {
		harness.setBranch(rawBranch);
		await emit(harness, "session_start", { reason });
		assert.deepEqual(harness.branch(), rawBefore);
	}
	harness.setBranch(rawBranch);
	await emit(harness, "session_tree", {});
	assert.deepEqual(harness.branch(), rawBefore);

	const canonical = [failed, user("continue after interruption")];
	const selection = await emit(harness, "context", { messages: canonical }) as any;
	assert.deepEqual(selection.messages, [canonical[1]]);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(harness.appendCalls(), 0);
	assert.deepEqual(harness.branch(), rawBefore);
});

test("selects canonical context and isolates raw-history failures", async () => {
	const harness = createHarness();
	const canonicalMessages = [user("CANONICAL_ONLY")];
	harness.setBranch([entry("raw", user("RAW_ONLY"))]);
	const canonical = await emit(harness, "context", { messages: canonicalMessages });
	assert.equal(hasMarker((canonical as any).messages, "CANONICAL_ONLY"), true);
	assert.equal(hasMarker((canonical as any).messages, "RAW_ONLY"), false);
	assert.deepEqual(canonical, { messages: canonicalMessages });
	assert.equal((canonical as any).messages, canonicalMessages);
	assert.equal((canonical as any).messages[0], canonicalMessages[0]);

	harness.setBranch([entry("orphan", result("missing", "ORPHAN_TOOL_RESULT"))]);
	assert.deepEqual(await emit(harness, "context", { messages: canonicalMessages }), {
		messages: canonicalMessages,
	});
	assert.equal(harness.abortCalls(), 0);
	assert.match(harness.notifications.at(-1)?.message ?? "", /ORPHAN_TOOL_RESULT/);

	const malformed = [result("orphan", "bad")];
	const malformedResult = await emit(harness, "context", { messages: malformed }) as any;
	assert.deepEqual(malformedResult, { messages: malformed });
	assert.equal(malformedResult.messages, malformed);
	assert.equal(malformedResult.messages[0], malformed[0]);
	assert.equal(harness.abortCalls(), 1);
	assert.match(harness.notifications.at(-1)?.message ?? "", /aborted this provider call/i);
});

test("uses a tracked measured anchor when raw history returns after paging", async (t) => {
	const prepares = t.mock.method(ContextUsageTracker.prototype, "prepare");
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 64_000, trimToTokens: 64_000 } },
		projectTrusted: false,
	});
	const old = user(`OLD_RAW_HISTORY ${"x".repeat(300_000)}`);
	const active = user("ACTIVE_REQUEST");
	const first = await emit(harness, "context", { messages: [old, active] }) as any;
	assert.equal(hasMarker(first.messages, "OLD_RAW_HISTORY"), false);

	const response = assistant("MODEL_RESPONSE", { totalTokens: 50_000 });
	const next = user("NEXT_REQUEST");
	harness.setBranch([entry("old", old), entry("active", active), entry("response", response), entry("next", next)]);
	await emit(harness, "turn_end", { message: response });
	harness.setContextUsage({ tokens: statusTokens(50_000, [next]), contextWindow: 64_000, percent: 78 });
	const second = await emit(harness, "context", { messages: [old, active, response, next] }) as any;

	assert.equal(typeof prepares.mock.calls.at(-1)?.result, "number", "the real tracker supplies measured accounting");
	assert.equal(hasMarker(second.messages, "OLD_RAW_HISTORY"), false);
	assert.equal(hasMarker(second.messages, "ACTIVE_REQUEST"), true);
	assert.equal(hasMarker(second.messages, "NEXT_REQUEST"), true);
});

test("evicts consumed recovery through the extension without a false provider abort", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 400 } }, projectTrusted: false,
	});
	const request = user("ACTIVE_RECOVERY_REQUEST");
	harness.setBranch([entry("request", request)]);
	await emit(harness, "context", { messages: [request] });
	const warmup = { ...toolAssistant("warmup"), usage: { totalTokens: 90 } };
	const warmupResult = result("warmup", "small result");
	harness.setBranch([...harness.branch(), entry("warmup", warmup), entry("warmup-result", warmupResult)]);
	await emit(harness, "turn_end", { message: warmup });

	const load = toolAssistant("recovery");
	const payload = result("recovery", "RECOVERY_PAYLOAD " + "x".repeat(3_000));
	harness.setBranch([...harness.branch(), entry("load", load), entry("payload", payload)]);
	harness.setContextUsage({ tokens: statusTokens(90, [warmupResult, load, payload]) });
	const unread = await emit(harness, "context", { messages: harness.branch().map((item) => item.message) }) as any;
	assert.equal(hasMarker(unread.messages, "RECOVERY_PAYLOAD"), true, "newest unread recovery remains protected");

	const response = { ...toolAssistant("continuation"), usage: { totalTokens: 1_500 } };
	const newest = result("continuation", "NEWEST_RESULT");
	harness.setBranch([...harness.branch(), entry("response", response), entry("newest", newest)]);
	await emit(harness, "turn_end", { message: response });
	harness.setContextUsage({ tokens: statusTokens(1_500, [newest]) });
	const stored = JSON.stringify(harness.branch());
	const selected = await emit(harness, "context", { messages: harness.branch().map((item) => item.message) }) as any;
	assert.equal(harness.abortCalls(), 0);
	assert.equal(hasMarker(selected.messages, "RECOVERY_PAYLOAD"), false);
	assert.equal(hasMarker(selected.messages, "ACTIVE_RECOVERY_REQUEST"), true);
	assert.equal(hasMarker(selected.messages, "NEWEST_RESULT"), true);
	assert.equal(JSON.stringify(harness.branch()), stored);
});

test("keeps persistent requests, outgoing instructions, and protected tool continuations", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 300 } },
		projectTrusted: false,
	});
	const old = user(`OLD ${"x".repeat(2_000)}`);
	const actual = user(`ACTUAL ${"x".repeat(800)}`);
	const call = toolAssistant("protected-call");
	const toolResult = result("protected-call", `PROTECTED_RESULT ${"x".repeat(800)}`);
	const injected = user("outgoing extension instruction");
	harness.setBranch([
		entry("old", old),
		entry("actual", actual),
		entry("call", call),
		entry("result", toolResult),
	]);
	const selection = await emit(harness, "context", { messages: [old, actual, call, toolResult, injected] }) as any;

	assert.equal(hasMarker(selection.messages, "OLD"), false);
	assert.equal(hasMarker(selection.messages, "ACTUAL"), true);
	assert.equal(hasMarker(selection.messages, "PROTECTED_RESULT"), true);
	assert.equal(hasMarker(selection.messages, "outgoing extension instruction"), true);
	assert.equal(harness.abortCalls(), 0);
});

test("uses measured anchors across repeated paged requests with a protected tool continuation", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 400 } },
		projectTrusted: false,
	});
	const old = user(`OLD_RESTORED ${"x".repeat(2_000)}`);
	const requestA = user("REQUEST_A");
	const instructionA = user("OUTGOING_A");
	harness.setBranch([entry("old", old), entry("request-a", requestA)]);
	const selectedA = await emit(harness, "context", { messages: [old, requestA, instructionA] }) as any;
	assert.equal(hasMarker(selectedA.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedA.messages, "OUTGOING_A"), true);
	assert.equal(selectedA.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const responseA = assistant(`RESPONSE_A ${"y".repeat(2_000)}`, { input: 10, output: 10, cacheRead: 20, cacheWrite: 10 });
	const requestB = user("REQUEST_B");
	const callB = toolAssistant("request-b-call");
	const resultB = result("request-b-call", `RESULT_B ${"x".repeat(800)}`);
	const instructionB = user("OUTGOING_B");
	harness.setBranch([
		entry("old", old), entry("request-a", requestA), entry("response-a", responseA),
		entry("request-b", requestB), entry("call-b", callB), entry("result-b", resultB),
	]);
	await emit(harness, "turn_end", { message: responseA });
	harness.setContextUsage({ tokens: statusTokens(50, [requestB, callB, resultB]), contextWindow: 64_000, percent: 1 });
	const selectedB = await emit(harness, "context", { messages: [old, requestA, responseA, requestB, callB, resultB, instructionB] }) as any;
	assert.equal(hasMarker(selectedB.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedB.messages, "REQUEST_A"), true, "measured usage retains the previous request");
	assert.equal(hasMarker(selectedB.messages, "REQUEST_B"), true);
	assert.equal(hasMarker(selectedB.messages, "RESULT_B"), true);
	assert.equal(hasMarker(selectedB.messages, "OUTGOING_B"), true);
	assert.equal(selectedB.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const responseB = assistant(`RESPONSE_B ${"z".repeat(2_000)}`, { input: 10, output: 10, cacheRead: 30, cacheWrite: 10 });
	const requestC = user("REQUEST_C");
	const instructionC = user("OUTGOING_C");
	harness.setBranch([...harness.branch(), entry("response-b", responseB), entry("request-c", requestC)]);
	await emit(harness, "turn_end", { message: responseB });
	harness.setContextUsage({ tokens: statusTokens(60, [requestC]), contextWindow: 64_000, percent: 1 });
	const selectedC = await emit(harness, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, responseB, requestC, instructionC],
	}) as any;
	assert.equal(hasMarker(selectedC.messages, "OLD_RESTORED"), false);
	assert.equal(hasMarker(selectedC.messages, "RESULT_B"), true);
	assert.equal(hasMarker(selectedC.messages, "REQUEST_C"), true);
	assert.equal(hasMarker(selectedC.messages, "OUTGOING_C"), true);
	assert.equal(selectedC.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);

	const fallback = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 400 } }, projectTrusted: false,
	});
	fallback.setBranch([
		entry("old", old), entry("request-a", requestA), entry("response-a", responseA),
		entry("request-b", requestB), entry("call-b", callB), entry("result-b", resultB),
	]);
	fallback.setContextUsage({ tokens: statusTokens(50, [requestB, callB, resultB]) });
	const fallbackB = await emit(fallback, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, instructionB],
	}) as any;
	assert.equal(hasMarker(fallbackB.messages, "REQUEST_A"), false, "fallback must evict the marker measured B retains");
	assert.equal(hasMarker(fallbackB.messages, "REQUEST_B"), true);
	assert.equal(hasMarker(fallbackB.messages, "RESULT_B"), true);
	assert.equal(hasMarker(fallbackB.messages, "OUTGOING_B"), true);
	fallback.setBranch(harness.branch());
	fallback.setContextUsage({ tokens: statusTokens(60, [requestC]) });
	const fallbackC = await emit(fallback, "context", {
		messages: [old, requestA, responseA, requestB, callB, resultB, responseB, requestC, instructionC],
	}) as any;
	assert.equal(hasMarker(fallbackC.messages, "RESULT_B"), false, "fallback must evict the tool result measured C retains");
	assert.equal(hasMarker(fallbackC.messages, "REQUEST_C"), true);
	assert.equal(hasMarker(fallbackC.messages, "OUTGOING_C"), true);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(fallback.abortCalls(), 0);
});

test("uses outgoing-only provenance for measured anchors and clears it after projection failure", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 220 } },
		projectTrusted: false,
	});
	const actual = user(`ACTUAL_REQUEST ${"x".repeat(300)}`);
	const injected = user("outgoing extension instruction");
	harness.setBranch([entry("actual", actual)]);
	assert.equal(hasMarker((await emit(harness, "context", { messages: [actual, injected] }) as any).messages, "ACTUAL_REQUEST"), true);

	const response = assistant("MODEL_RESPONSE ".repeat(40), { totalTokens: 51 });
	harness.setBranch([entry("actual", actual), entry("response", response)]);
	await emit(harness, "turn_end", { message: response });
	const next = user("NEXT_REQUEST");
	const canonical = [actual, response, next];
	harness.setBranch([...harness.branch(), entry("next", next)]);
	harness.setContextUsage({ tokens: statusTokens(51, [next]), contextWindow: 64_000, percent: 1 });
	const measured = await emit(harness, "context", { messages: canonical }) as any;
	assert.equal(hasMarker(measured.messages, "ACTUAL_REQUEST"), true, "the outgoing instruction removal is calibrated");

	harness.setBranchError(new Error("PROJECTION_FAILURE"));
	const fallback = await emit(harness, "context", { messages: canonical }) as any;
	assert.equal(hasMarker(fallback.messages, "ACTUAL_REQUEST"), false, "unknown branch state must not reuse measured usage");
	assert.match(harness.notifications.at(-1)?.message ?? "", /PROJECTION_FAILURE/);
});

test("counts a persisted system/tool update once at the measured threshold for both outgoing shapes", async () => {
	for (const includeSystem of [false, true]) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 111 } }, projectTrusted: false,
		});
		const actual = user("ACTUAL_REQUEST");
		const response = assistant("answer", { totalTokens: 100 });
		const update = { role: "system", content: "s".repeat(24), toolsAdded: [{ name: "t" }] };
		const next = user("next");
		harness.setBranch([entry("actual", actual)]);
		await emit(harness, "context", { messages: [actual] });
		await emit(harness, "turn_end", { message: response });
		harness.setBranch([entry("actual", actual), entry("response", response), entry("update", update), entry("next", next)]);
		const oldSystem = harness.ctx.getSystemPrompt();
		harness.ctx.getSystemPrompt = () => oldSystem + "s".repeat(40);
		const status = statusTokens(100, [update, next]);
		assert.equal(status, 111);
		harness.setContextUsage({ tokens: status });
		const messages = includeSystem ? [actual, response, update, next] : [actual, response, next];
		const selected = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
		assert.deepEqual(selected.messages, messages, `111-token request fits without paging (system metadata: ${includeSystem})`);
		assert.equal(hasMarker(selected.messages, "ACTUAL_REQUEST"), true);
		assert.equal(hasMarker(selected.messages, "next"), true);
		assert.equal(hasNotice(selected.messages), false);
		assert.equal(harness.abortCalls(), 0);
	}
});

test("resumes measured accounting from projected compaction and context-edit messages", async () => {
	for (const type of ["compaction", "context_edit"] as const) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 220 } },
			projectTrusted: false,
		});
		const replaced = user(`REPLACED_${type} ${"x".repeat(2_000)}`);
		const summary = user(`PROJECTED_${type} ${"x".repeat(400)}`);
		const response = assistant(`RESPONSE_${type} ${"y".repeat(600)}`, { totalTokens: 50 });
		const next = user(`NEXT_${type}`);
		harness.setBranch([
			entry("replaced", replaced),
			{ id: type, type, timestamp: "2026-09-21T00:00:00.000Z" } as any,
		]);
		harness.setProjectedMessages([summary]);
		await emit(harness, "context", { messages: [summary] });
		harness.setBranch([...harness.branch(), entry("response", response), entry("next", next)]);
		harness.setProjectedMessages([summary, response, next]);
		await emit(harness, "turn_end", { message: response });
		harness.setContextUsage({ tokens: statusTokens(50, [next]), contextWindow: 64_000, percent: 1 });

		const selected = await emit(harness, "context", { messages: [summary, response, next] }) as any;
		assert.equal(hasMarker(selected.messages, `PROJECTED_${type}`), true, `${type} projection restores measured accounting`);
		assert.equal(hasMarker(selected.messages, `NEXT_${type}`), true);
		assert.equal(harness.abortCalls(), 0);
		await emit(harness, "model_select", {});
		const fallback = await emit(harness, "context", { messages: [summary, response, next] }) as any;
		assert.equal(hasMarker(fallback.messages, `PROJECTED_${type}`), false, `${type} fallback must evict the measured marker`);
		assert.equal(hasMarker(fallback.messages, `NEXT_${type}`), true);
		assert.equal(harness.abortCalls(), 0);
	}
});

test("clears independently re-established measured accounting for lifecycle changes", async () => {
	const invalidators: Array<[string, (harness: ReturnType<typeof createHarness>) => Promise<void>]> = [
		["session tree", (harness) => emit(harness, "session_tree", {}).then(() => undefined)],
		["model", (harness) => emit(harness, "model_select", {}).then(() => undefined)],
		["context-paging off/on", async (harness) => {
			await runPagingCommand(harness, "off");
			await runPagingCommand(harness, "on");
		}],
		["compaction", (harness) => emit(harness, "session_compact", {}).then(() => undefined)],
		["session", (harness) => emit(harness, "session_start", { reason: "new" }).then(() => undefined)],
		["manual compaction", (harness) => emit(harness, "session_before_compact", { reason: "manual" }).then(() => undefined)],
		["context edit", async (harness) => {
			harness.setBranch([
				...harness.branch(),
				{ id: "edit", type: "context_edit", timestamp: "2026-09-21T00:00:00.000Z" } as any,
			]);
		}],
	];

	for (const [name, invalidate] of invalidators) {
		const harness = createHarness({
			globalSettings: { contextPaging: { enabled: true, tokenBudget: 220 } },
			projectTrusted: false,
		});
		const anchored = user(`ANCHOR_${name} ${"x".repeat(480)}`);
		const response = assistant(`RESPONSE_${name} ${"y".repeat(400)}`, { totalTokens: 50 });
		const next = user(`NEXT_${name}`);
		harness.setBranch([entry("anchored", anchored)]);
		await emit(harness, "context", { messages: [anchored] });
		assert.equal(harness.abortCalls(), 0, `${name} establishes an anchor`);
		harness.setBranch([entry("anchored", anchored), entry("response", response), entry("next", next)]);
		harness.setProjectedMessages([anchored, response, next]);
		await emit(harness, "turn_end", { message: response });
		harness.setContextUsage({ tokens: statusTokens(50, [next]), contextWindow: 64_000, percent: 1 });

		const measured = await emit(harness, "context", { messages: [anchored, response, next] }) as any;
		assert.equal(harness.abortCalls(), 0, `${name} uses its measured anchor`);
		assert.equal(hasMarker(measured.messages, `ANCHOR_${name}`), true, `${name} begins on the measured path`);
		await invalidate(harness);
		const fallback = await emit(harness, "context", { messages: [anchored, response, next] }) as any;
		assert.equal(hasMarker(fallback.messages, `ANCHOR_${name}`), false, `${name} falls back after invalidation`);
	}
});

test("fails closed when session settings cannot be parsed", async () => {
	const previousHome = process.env.HOME;
	const home = await mkdtemp(join(tmpdir(), "context-paging-settings-"));
	try {
		process.env.HOME = home;
		const agentDirectory = join(home, ".pi", "agent");
		const settingsPath = join(agentDirectory, "settings.json");
		await mkdir(agentDirectory, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ contextPaging: { enabled: true } }));
		const harness = createHarness(null);
		await emit(harness, "session_start", { reason: "startup" });
		assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), { cancel: true });

		await writeFile(settingsPath, "{");
		await assert.rejects(() => emit(harness, "session_start", { reason: "reload" }), SyntaxError);
		assert.equal(await emit(harness, "context", { messages: [user("unchanged")] }), undefined);
		assert.equal(await emit(harness, "session_before_compact", { reason: "threshold" }), undefined);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("does not rebuild the navigator during a context event", async () => {
	const harness = createHarness();
	const originalRebuild = HistoryNavigator.prototype.rebuild;
	let rebuilds = 0;
	HistoryNavigator.prototype.rebuild = function (items) {
		rebuilds++;
		return originalRebuild.call(this, items);
	};
	try {
		await emit(harness, "context", { messages: [user("canonical")] });
		assert.equal(rebuilds, 0);
	} finally {
		HistoryNavigator.prototype.rebuild = originalRebuild;
	}
});

test("refreshes lifecycle history and reuses navigation until visible history changes", async () => {
	const harness = createHarness();
	const originalRebuild = HistoryNavigator.prototype.rebuild;
	let rebuilds = 0;
	HistoryNavigator.prototype.rebuild = function (items) {
		rebuilds++;
		return originalRebuild.call(this, items);
	};
	try {
		harness.setBranch(branchFor("visible"));
		await emit(harness, "turn_end", {});
		assert.equal(rebuilds, 0);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);

		harness.setBranch([
			...branchFor("visible"),
			entry("paging-assistant", toolAssistant("paging-call", "search_history")),
			entry("paging-result", result("paging-call", "paging result")),
		]);
		await emit(harness, "turn_end", {});
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "visible"), ["user-visible"]);
		assert.equal(rebuilds, 1);
		const read = harness.tools.find((tool) => tool.name === "read_context_output");
		await assert.rejects(() => read.execute("call", {
			historyId: "paging-assistant",
			source: "assistant",
			contentIndex: 0,
		}, undefined, undefined, harness.ctx), /not public recovery output/i);

		harness.setBranch(branchFor("replacement"));
		await emit(harness, "session_tree", {});
		assert.equal(rebuilds, 1);
		assert.deepEqual(await searchIds(harness, "replacement"), ["user-replacement"]);
		assert.equal(rebuilds, 2);
	} finally {
		HistoryNavigator.prototype.rebuild = originalRebuild;
	}
});

test("does not abort custom requests and preserves their canonical role", async () => {
	const harness = createHarness();
	const customOnly = custom("CUSTOM_ONLY_REQUEST");
	const customOnlyResult = await emit(harness, "context", { messages: [customOnly] }) as any;
	assert.deepEqual(customOnlyResult.messages, [customOnly]);
	assert.equal(customOnlyResult.messages[0].role, "custom");
	assert.equal(harness.abortCalls(), 0);

	const completedUser = user("COMPLETED_USER_REQUEST");
	const completedAnswer = { role: "assistant" as const, content: [{ type: "text" as const, text: "COMPLETED_USER_ANSWER" }], timestamp: 0 };
	const customFollowUp = custom("CUSTOM_FOLLOW_UP_REQUEST");
	const toolCall = toolAssistant("custom-follow-up-call");
	const toolResult = result("custom-follow-up-call", "CUSTOM_TOOL_RESULT");
	const followUpResult = await emit(harness, "context", {
		messages: [completedUser, completedAnswer, customFollowUp, toolCall, toolResult],
	}) as any;

	assert.deepEqual(followUpResult.messages, [completedUser, completedAnswer, customFollowUp, toolCall, toolResult]);
	assert.equal(followUpResult.messages[2].role, "custom");
	assert.equal(followUpResult.messages[3].content[0].id, "custom-follow-up-call");
	assert.equal(followUpResult.messages[4].toolCallId, "custom-follow-up-call");
	assert.equal(harness.abortCalls(), 0);
});

test("does not mutate stored history and generates transient notices", async () => {
	const harness = createHarness({
		globalSettings: { contextPaging: { enabled: true, tokenBudget: 32_000 } },
		projectTrusted: false,
	});
	const canonicalMessages = [user(`old ${"x".repeat(300_000)}`), user("current")];
	const rawBefore = structuredClone(harness.branch());
	const canonicalBefore = structuredClone(canonicalMessages);
	const first = await emit(harness, "context", { messages: canonicalMessages }) as any;
	const second = await emit(harness, "context", { messages: canonicalMessages }) as any;
	assert.deepEqual(harness.branch(), rawBefore);
	assert.deepEqual(canonicalMessages, canonicalBefore);
	assert.equal(harness.abortCalls(), 0);
	assert.equal(harness.appendCalls(), 0);
	assert.equal(first.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);
	assert.equal(second.messages.filter((message: any) => marker(message).includes("Context paging notice")).length, 1);
	assert.match(marker(first.messages[0]), /Older context left the 32,000-token rolling window\./);
	assert.match(marker(second.messages[0]), /Older context left the 32,000-token rolling window\./);
	assert.equal(hasNotice(harness.branch().map((item: any) => item.message)), false);
});

test("cancels only automatic compaction and leaves disabled paging inert", async () => {
	const enabled = createHarness();
	assert.deepEqual(await emit(enabled, "session_before_compact", { reason: "threshold" }), { cancel: true });
	assert.deepEqual(await emit(enabled, "session_before_compact", { reason: "overflow" }), { cancel: true });
	assert.equal(await emit(enabled, "session_before_compact", { reason: "manual" }), undefined);

	const disabled = createHarness({ globalSettings: { contextPaging: { enabled: false } }, projectTrusted: false });
	for (const reason of ["threshold", "overflow", "manual"]) {
		assert.equal(await emit(disabled, "session_before_compact", { reason }), undefined);
	}
	const messages = [user("unchanged")];
	assert.equal(await emit(disabled, "context", { messages }), undefined);
});

test("context-paging status reports the effective state without changing it", async () => {
	for (const enabled of [true, false]) {
		const harness = createHarness({ globalSettings: { contextPaging: { enabled } }, projectTrusted: false });
		for (const args of ["", "status", "  status  "]) {
			await runPagingCommand(harness, args);
			assert.match(harness.notifications.at(-1)!.message, enabled ? /enabled/ : /disabled/);
			assert.equal(harness.notifications.at(-1)!.level, "info");
			assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), enabled ? { cancel: true } : undefined);
		}
	}
});

test("context-paging off leaves outgoing context unchanged and disables all recovery tools", async () => {
	const { harness, messages } = resetFixture();
	const before = structuredClone(harness.branch());
	await runPagingCommand(harness, "  off  ");
	assert.match(harness.notifications.at(-1)!.message, /disabled.*session/);
	assert.equal(await emit(harness, "context", { messages }), undefined);
	for (const reason of ["threshold", "overflow", "manual"]) {
		assert.equal(await emit(harness, "session_before_compact", { reason }), undefined);
	}
	for (const tool of harness.tools) {
		await assert.rejects(() => tool.execute("call", {}, undefined, undefined, harness.ctx), /recovery tools are disabled/);
	}
	assert.deepEqual(harness.branch(), before);
	assert.equal(harness.appendCalls(), 0);
	assert.equal(harness.abortCalls(), 0);
});

test("context-paging on overrides disabled settings and uses the configured token budget", async () => {
	const { harness, messages } = resetFixture(false);
	await runPagingCommand(harness, "on");
	assert.match(harness.notifications.at(-1)!.message, /enabled.*session/);
	const selection = await emit(harness, "context", { messages }) as any;
	assert.equal(hasMarker(selection.messages, "RESET_A request"), false);
	assert.match(marker(selection.messages[0]), /1,000-token rolling window/);
	assert.ok((await searchIds(harness, "RESET_A request")).includes("reset-0"));
	for (const reason of ["threshold", "overflow"]) {
		assert.deepEqual(await emit(harness, "session_before_compact", { reason }), { cancel: true });
	}
	assert.equal(await emit(harness, "session_before_compact", { reason: "manual" }), undefined);
	assert.equal(harness.abortCalls(), 0);
});

test("context-paging rejects invalid arguments without changing state or a committed cut", async () => {
	const { harness, messages } = resetFixture();
	const first = await emit(harness, "context", { messages }) as any;
	assert.equal(hasMarker(first.messages, "RESET_A request"), false);
	harness.ctx.getSystemPrompt = () => "system";
	for (const args of ["enable", "on off", "status extra"]) {
		await runPagingCommand(harness, args);
		assert.equal(harness.notifications.at(-1)!.level, "warning");
		assert.match(harness.notifications.at(-1)!.message, /context-paging.*on.*off.*status/);
		const selection = await emit(harness, "context", { messages }) as any;
		assert.deepEqual(selection.messages, first.messages);
	}
	await runPagingCommand(harness, "off");
	await runPagingCommand(harness, "invalid");
	assert.equal(await emit(harness, "context", { messages }), undefined);
});

test("context-paging preserves a cut for status and repeated on but resets it across off/on", async () => {
	const { harness, messages } = resetFixture();
	const first = await emit(harness, "context", { messages }) as any;
	assert.equal(hasMarker(first.messages, "RESET_A request"), false);
	harness.ctx.getSystemPrompt = () => "system";
	for (const args of ["", "status", "on", "on"]) {
		await runPagingCommand(harness, args);
		const selected = await emit(harness, "context", { messages }) as any;
		assert.deepEqual(selected.messages, first.messages);
	}
	await runPagingCommand(harness, "off");
	await runPagingCommand(harness, "on");
	const restored = await emit(harness, "context", { messages }) as any;
	assert.equal(hasMarker(restored.messages, "RESET_A request"), true);
	assert.equal(hasNotice(restored.messages), false);
});

test("context-paging resets its override at every session start", async () => {
	for (const enabled of [true, false]) {
		const harness = createHarness({ globalSettings: { contextPaging: { enabled } }, projectTrusted: false });
		for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
			await runPagingCommand(harness, enabled ? "off" : "on");
			await emit(harness, "session_start", { reason });
			await runPagingCommand(harness, "status");
			assert.match(harness.notifications.at(-1)!.message, enabled ? /enabled/ : /disabled/);
			assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), enabled ? { cancel: true } : undefined);
		}
	}
});

test("context-paging keeps its override through branch navigation, model changes, and manual compaction", async () => {
	for (const enabled of [true, false]) {
		const harness = createHarness({ globalSettings: { contextPaging: { enabled } }, projectTrusted: false });
		await runPagingCommand(harness, enabled ? "off" : "on");
		for (const name of ["session_tree", "model_select", "session_compact"]) {
			await emit(harness, name, {});
			assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), enabled ? undefined : { cancel: true });
		}
	}
});

test("context-paging changes neither saved settings nor session entries", async () => {
	const previousHome = process.env.HOME;
	const home = await mkdtemp(join(tmpdir(), "context-paging-command-"));
	try {
		process.env.HOME = home;
		const agentDirectory = join(home, ".pi", "agent");
		const settingsPath = join(agentDirectory, "settings.json");
		await mkdir(agentDirectory, { recursive: true });
		for (const enabled of [true, false]) {
			const saved = JSON.stringify({ contextPaging: { enabled, tokenBudget: 96_000 }, unrelated: "unchanged" });
			await writeFile(settingsPath, saved);
			const harness = createHarness(null);
			await emit(harness, "session_start", { reason: "startup" });
			await runPagingCommand(harness, enabled ? "off" : "on");
			assert.equal(await readFile(settingsPath, "utf8"), saved);
			assert.equal(harness.appendCalls(), 0);
			await emit(harness, "session_start", { reason: "reload" });
			assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), enabled ? { cancel: true } : undefined);
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

// Frontier lifecycle: real selector/tracker, canonical custom projection, no provider calls.
function integrationFixture(kind: "completed" | "active" | "custom-active"): PagingFixture {
	const fixture = pagingFixture(kind);
	return fixtureFromEntries(fixture.entries.map((item) => {
		if (item.type !== "message") return item;
		if (kind === "completed" && item.id.startsWith("turn-old-")) {
			return { ...item, message: { ...item.message, content: [{ type: "text", text: `${item.id} payload ${"x".repeat(160_000)}` }] } } as typeof item;
		}
		if (kind !== "completed" && item.message.role === "toolResult") {
			return { ...item, message: { ...item.message, content: [{ type: "text", text: `${item.id} payload ${"x".repeat(140_000)}` }] } };
		}
		return item;
	}));
}

function fixtureHarness(fixture: PagingFixture) {
	const harness = createHarness({ globalSettings: { contextPaging: { tokenBudget: 128_000 } }, projectTrusted: false });
	harness.ctx.model.contextWindow = 128_000;
	harness.setBranch(fixture.entries);
	return harness;
}

function resetFixture(enabled = true) {
	const harness = createHarness({ globalSettings: { contextPaging: { enabled, tokenBudget: 1_000 } }, projectTrusted: false });
	const messages = ["RESET_A", "RESET_B", "RESET_C"].flatMap((id) => [user(`${id} request`), assistant(`${id} ${"x".repeat(960)}`)]);
	messages.push(user("RESET_ACTIVE"));
	harness.setBranch(messages.map((message, index) => entry(`reset-${index}`, message)));
	harness.ctx.getSystemPrompt = () => "s".repeat(2_000);
	return { harness, messages };
}

function projectedInvalidation(harness: ReturnType<typeof createHarness>, type: "context_edit" | "compaction", id: string) {
	const branch = harness.branch();
	const metadata = { id, parentId: branch.at(-1)!.id, timestamp: "2026-09-21T00:00:00.000Z" };
	const saved = type === "compaction"
		? { ...metadata, type, summary: "PROJECTED_COMPACTION", firstKeptEntryId: "reset-0", tokensBefore: 1_300 }
		: { ...metadata, type, targetId: "reset-6", replacement: { content: "RESET_ACTIVE edited" } };
	const fixture = fixtureFromEntries([...branch, saved]);
	return { entry: fixture.entries.at(-1)!, entries: fixture.entries, messages: [...fixture.input.messages] };
}

// Pi's retry path saves the response, then omits it with a null context edit.
function omittedAttempt(harness: ReturnType<typeof createHarness>, stopReason: string) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: stopReason === "stop" ? 50 : 0 };
	const attempt = entry(`attempt-${stopReason}`, assistant(`ATTEMPT_${stopReason}`, usage, stopReason));
	const omission = {
		type: "context_edit", id: `omit-${stopReason}`, timestamp: "2026-09-21T00:00:00.000Z",
		targetId: attempt.id, replacement: null,
	};
	const fixture = fixtureFromEntries([...harness.branch(), attempt, omission]);
	return { attempt, entries: fixture.entries, messages: [...fixture.input.messages] };
}

for (const kind of ["active", "custom-active"] as const) {
	test(`${kind} commits its partial cut across clones and turn completion`, async (t) => {
		const commits = t.mock.method(ContextCutState.prototype, "commit");
		const prepares = t.mock.method(ContextUsageTracker.prototype, "prepare");
		const fixture = integrationFixture(kind);
		const harness = fixtureHarness(fixture);
		const original = fixture.input.messages;
		const first = await emit(harness, "context", { messages: original }) as any;
		const firstSnapshot = commits.mock.calls.at(-1)?.arguments[0];
		assert.equal(firstSnapshot?.frontier.kind, "partialTurn");
		assert.equal(firstSnapshot?.frontier.lastEvicted.historyId, "turn-live-2");
		assert.equal(prepares.mock.calls.at(-1)?.arguments[0], original);
		assert.equal(hasMarker(first.messages, "result-live-2 payload"), false);
		assert.equal(hasMarker(first.messages, "result-live-3 payload"), true);

		const cloned = structuredClone(original);
		const second = await emit(harness, "context", { messages: cloned }) as any;
		assert.ok(commits.mock.calls.at(-1)?.arguments[0], "the cloned call commits a real snapshot");
		assert.equal(prepares.mock.calls.at(-1)?.arguments[0], cloned);
		assert.deepEqual(second.messages, first.messages);
		if (kind === "custom-active") assert.equal(second.messages[1].role, "custom");

		const next = user("NEXT_AFTER_PARTIAL_COMPLETION");
		harness.setBranch([...fixture.entries, entry("next-partial-user", next)]);
		const lastAssistant = [...original].reverse().find((message) => message.role === "assistant");
		await emit(harness, "turn_end", { message: lastAssistant });
		const third = await emit(harness, "context", { messages: structuredClone([...original, next]) }) as any;
		assert.deepEqual(third.messages.slice(0, first.messages.length), first.messages);
		assert.deepEqual(commits.mock.calls.at(-1)?.arguments[0], firstSnapshot);
		assert.equal(hasMarker(third.messages, "result-live-2 payload"), false);
		assert.equal(hasMarker(third.messages, "NEXT_AFTER_PARTIAL_COMPLETION"), true);
		assert.equal(harness.appendCalls(), 0);
		assert.equal(harness.abortCalls(), 0);
	});
}

// A canceled attempt emits its before event but never the matching success event.
const canceledAttempts: Array<SessionBeforeTreeEvent | SessionBeforeForkEvent | SessionBeforeSwitchEvent> = [
	{
		type: "session_before_tree",
		preparation: {
			targetId: "reset-2", oldLeafId: "reset-6", commonAncestorId: "reset-2",
			entriesToSummarize: [], userWantsSummary: false,
		},
		signal: new AbortController().signal,
	},
	{ type: "session_before_fork", entryId: "reset-2", position: "at" },
	{ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/paging-canceled-session.jsonl" },
];
for (const event of canceledAttempts) {
	test(`canceled ${event.type} preserves the committed cut and frozen notice`, async (t) => {
		const commits = t.mock.method(ContextCutState.prototype, "commit");
		const { harness, messages } = resetFixture();
		const first = await emit(harness, "context", { messages }) as any;
		const snapshot = structuredClone(commits.mock.calls.at(-1)?.arguments[0]);
		assert.ok(snapshot);
		assert.equal(hasMarker(first.messages, "RESET_A request"), false);
		const notice = structuredClone(first.messages[0]);
		assert.equal(notice.role, "user");
		assert.match(marker(notice), /Context paging notice/);

		// This request would restore RESET_A if the before hook wrongly reset the cut.
		harness.ctx.getSystemPrompt = () => "system";
		assert.equal(await emit(harness, event.type, event), undefined);
		const next = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
		assert.deepEqual(next.messages, first.messages);
		assert.deepEqual(next.messages[0], notice);
		assert.deepEqual(commits.mock.calls.at(-1)?.arguments[0], snapshot);
		assert.equal(hasMarker(next.messages, "RESET_A request"), false);
		assert.equal(harness.abortCalls(), 0);
	});
}

for (const [name, event] of [
	["session_start", { reason: "new" }],
	["session_start", { reason: "resume" }],
	["session_start", { reason: "fork" }],
	["session_tree", {}],
	["session_compact", {}],
] as const) {
	test(`successful ${name} ${"reason" in event ? event.reason : ""} resets the frontier`, async (t) => {
		const commits = t.mock.method(ContextCutState.prototype, "commit");
		const { harness, messages } = resetFixture();
		const first = await emit(harness, "context", { messages }) as any;
		assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
		assert.equal(hasMarker(first.messages, "RESET_A request"), false);
		harness.ctx.getSystemPrompt = () => "system";
		await emit(harness, name, event);
		const next = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
		assert.equal(hasMarker(next.messages, "RESET_A request"), true);
		assert.equal(hasNotice(next.messages), false);
		assert.equal(harness.abortCalls(), 0);
	});
}

test("model switches reset the frontier in both window-size directions", async (t) => {
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const harness = createHarness({ globalSettings: { contextPaging: { tokenBudget: 128_000 } }, projectTrusted: false });
	const messages = ["WINDOW_A", "WINDOW_B", "WINDOW_C"].flatMap((id) => [user(id), assistant(`${id} ${"x".repeat(240_000)}`)]);
	messages.push(user("WINDOW_ACTIVE"));
	harness.setBranch(messages.map((message, index) => entry(`window-${index}`, message)));
	const small = await emit(harness, "context", { messages }) as any;
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
	assert.equal(hasMarker(small.messages, "WINDOW_C"), false);
	harness.ctx.model.contextWindow = 128_000;
	await emit(harness, "model_select", { model: harness.ctx.model });
	const large = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
	assert.equal(hasMarker(large.messages, "WINDOW_C"), true);
	harness.ctx.model.contextWindow = 64_000;
	await emit(harness, "model_select", { model: harness.ctx.model });
	const smallAgain = await emit(harness, "context", { messages: structuredClone(messages) }) as any;
	assert.equal(hasMarker(smallAgain.messages, "WINDOW_C"), false);
	assert.equal(hasMarker(smallAgain.messages, "WINDOW_ACTIVE"), true);
	assert.equal(harness.abortCalls(), 0);
});

test("a fresh extension has no prior frontier", async (t) => {
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const old = resetFixture();
	const selected = await emit(old.harness, "context", { messages: old.messages }) as any;
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
	assert.equal(hasMarker(selected.messages, "RESET_A request"), false);
	const fresh = resetFixture();
	fresh.harness.ctx.getSystemPrompt = () => "system";
	const restarted = await emit(fresh.harness, "context", { messages: fresh.messages }) as any;
	assert.equal(hasMarker(restarted.messages, "RESET_A request"), true);
	assert.equal(hasNotice(restarted.messages), false);
});

for (const type of ["context_edit", "compaction"] as const) {
	test(`a new projected ${type} invalidates once and freezes the rebuilt notice`, async (t) => {
		const resets = t.mock.method(ContextCutState.prototype, "reset");
		const commits = t.mock.method(ContextCutState.prototype, "commit");
		const { harness, messages } = resetFixture();
		await emit(harness, "context", { messages });
		assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
		const invalidation = projectedInvalidation(harness, type, `new-${type}`);
		harness.setBranch(invalidation.entries);
		const projected = invalidation.messages;
		harness.setProjectedMessages(projected);
		const resetCount = resets.mock.calls.length;
		const first = await emit(harness, "context", { messages: projected }) as any;
		assert.equal(resets.mock.calls.length, resetCount + 1);
		assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
		if (type === "context_edit") assert.equal(hasMarker(first.messages, "RESET_ACTIVE edited"), true);
		const second = await emit(harness, "context", { messages: structuredClone(projected) }) as any;
		assert.equal(resets.mock.calls.length, resetCount + 1);
		assert.deepEqual(second.messages, first.messages);
		assert.equal(harness.abortCalls(), 0);
	});
}

for (const [stopReason, resetsCut] of [["error", false], ["aborted", false], ["stop", true]] as const) {
	test(`an omitted ${stopReason} response ${resetsCut ? "resets" : "keeps"} the frontier`, async (t) => {
		const resets = t.mock.method(ContextCutState.prototype, "reset");
		const prepares = t.mock.method(ContextUsageTracker.prototype, "prepare");
		const { harness, messages } = resetFixture();
		await emit(harness, "context", { messages });
		const response = assistant("RESET_MEASURED_RESPONSE", { totalTokens: 50 });
		const next = user("RESET_NEXT");
		harness.setBranch([...harness.branch(), entry("reset-response", response), entry("reset-next", next)]);
		await emit(harness, "turn_end", { message: response });
		harness.setContextUsage({ tokens: statusTokens(50, [next]) });
		const anchored = await emit(harness, "context", { messages: [...messages, response, next] }) as any;
		assert.equal(typeof prepares.mock.calls.at(-1)?.result, "number");
		assert.equal(hasMarker(anchored.messages, "RESET_A request"), false);
		const resetCount = resets.mock.calls.length;
		const omission = omittedAttempt(harness, stopReason);
		harness.setBranch(omission.entries.slice(0, -1));
		await emit(harness, "turn_end", { message: omission.attempt.message });
		harness.setBranch(omission.entries);
		harness.setProjectedMessages(omission.messages);
		// After any edit, Pi's status estimates the whole projection until the next measured response.
		harness.setContextUsage({ tokens: 1_000_000 });
		// This retry would restore RESET_A if the omission reset the cut.
		harness.ctx.getSystemPrompt = () => "system";
		const retry = await emit(harness, "context", { messages: omission.messages }) as any;
		assert.equal(prepares.mock.calls.at(-1)?.result, undefined);
		assert.equal(resets.mock.calls.length, resetCount + (resetsCut ? 1 : 0));
		assert.equal(hasMarker(retry.messages, "RESET_A request"), resetsCut);
		if (!resetsCut) assert.deepEqual(retry.messages, anchored.messages);
		assert.equal(harness.abortCalls(), 0);
	});
}

for (const order of ["event-first", "entry-first"] as const) {
	test(`${order} compaction signals cannot clear the rebuilt frontier twice`, async (t) => {
		const resets = t.mock.method(ContextCutState.prototype, "reset");
		const commits = t.mock.method(ContextCutState.prototype, "commit");
		const { harness, messages } = resetFixture();
		await emit(harness, "context", { messages });
		const compaction = projectedInvalidation(harness, "compaction", "compact-once");
		const compactionEntry = compaction.entry;
		const projected = compaction.messages;
		harness.setProjectedMessages(projected);
		if (order === "event-first") await emit(harness, "session_compact", { compactionEntry });
		else harness.setBranch(compaction.entries);
		const first = await emit(harness, "context", { messages: projected }) as any;
		assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
		const afterFirst = resets.mock.calls.length;
		harness.ctx.getSystemPrompt = () => "system";
		if (order === "event-first") harness.setBranch(compaction.entries);
		else await emit(harness, "session_compact", { compactionEntry });
		const second = await emit(harness, "context", { messages: structuredClone(projected) }) as any;
		assert.equal(resets.mock.calls.length, afterFirst);
		assert.deepEqual(second.messages, first.messages);
		assert.equal(hasMarker(second.messages, "RESET_A request"), false);
		harness.ctx.getSystemPrompt = () => "s".repeat(2_000);
		const newer = projectedInvalidation(harness, "compaction", "compact-twice");
		harness.setBranch(newer.entries);
		harness.setProjectedMessages(newer.messages);
		await emit(harness, "session_compact", { compactionEntry: newer.entry });
		assert.equal(resets.mock.calls.length, afterFirst + 1);
		const afterNewer = await emit(harness, "context", { messages: newer.messages }) as any;
		assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
		assert.equal(resets.mock.calls.length, afterFirst + 1);
		assert.equal(hasMarker(afterNewer.messages, "RESET_A request"), false);
		assert.equal(harness.abortCalls(), 0);
	});
}

test("canceled compaction accounting fallback does not reset the cut", async (t) => {
	const prepares = t.mock.method(ContextUsageTracker.prototype, "prepare");
	const { harness, messages } = resetFixture();
	const first = await emit(harness, "context", { messages }) as any;
	const response = assistant("RESET_MEASURED_RESPONSE", { totalTokens: 50 });
	const next = user("RESET_NEXT");
	harness.setBranch([...harness.branch(), entry("reset-response", response), entry("reset-next", next)]);
	await emit(harness, "turn_end", { message: response });
	harness.setContextUsage({ tokens: statusTokens(50, [next]) });
	harness.ctx.getSystemPrompt = () => "system";
	const incoming = [...messages, response, next];
	const anchored = await emit(harness, "context", { messages: incoming }) as any;
	assert.equal(typeof prepares.mock.calls.at(-1)?.result, "number");
	assert.deepEqual(anchored.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(await emit(harness, "session_before_compact", { reason: "threshold" }), { cancel: true });
	const canceled = await emit(harness, "context", { messages: structuredClone(incoming) }) as any;
	assert.deepEqual(canceled.messages, anchored.messages);
	await emit(harness, "session_before_compact", { reason: "manual" });
	const fallback = await emit(harness, "context", { messages: structuredClone(incoming) }) as any;
	assert.equal(prepares.mock.calls.at(-1)?.result, undefined);
	assert.deepEqual(fallback.messages, anchored.messages);
	assert.equal(hasMarker(fallback.messages, "RESET_A request"), false);
	assert.equal(harness.abortCalls(), 0);
});

test("a failed selection never commits a candidate frontier", async (t) => {
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const fixture = integrationFixture("active");
	const harness = fixtureHarness(fixture);
	const first = await emit(harness, "context", { messages: fixture.input.messages }) as any;
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
	const before = commits.mock.calls.length;
	const malformed = [result("missing-call", "INVALID_ORIGINAL_EXCHANGE"), ...fixture.input.messages];
	const failed = await emit(harness, "context", { messages: malformed }) as any;
	assert.equal(failed.messages, malformed);
	assert.equal(commits.mock.calls.length, before);
	assert.equal(harness.abortCalls(), 1);
	const retry = await emit(harness, "context", { messages: structuredClone(fixture.input.messages) }) as any;
	assert.deepEqual(retry.messages, first.messages);
	assert.equal(harness.appendCalls(), 0);
});

test("warns once for an inherited high target across calls and model switches", async (t) => {
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const settings = {
		globalSettings: { contextPaging: { tokenBudget: 128_000, trimToTokens: 80_000 } },
		projectSettings: { contextPaging: { tokenBudget: 64_000 } }, projectTrusted: true,
	};
	const fixture = integrationFixture("completed");
	const harness = createHarness(settings);
	harness.setBranch(fixture.entries);
	const first = await emit(harness, "context", { messages: fixture.input.messages }) as any;
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
	const second = await emit(harness, "context", { messages: structuredClone(fixture.input.messages) }) as any;
	assert.deepEqual(second.messages, first.messages);
	harness.ctx.model.contextWindow = 128_000;
	await emit(harness, "model_select", { model: harness.ctx.model });
	await emit(harness, "context", { messages: fixture.input.messages });
	const warnings = harness.notifications.filter(({ message }) => /tokenBudget.*trimToTokens|trimToTokens.*tokenBudget/.test(message));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!.message, /64[,_]?000/);
	assert.match(warnings[0]!.message, /80[,_]?000/);
	assert.match(warnings[0]!.message, /headroom|room between cuts/);
	const fresh = createHarness(settings);
	await emit(fresh, "context", { messages: [user("NEW_INSTANCE")] });
	assert.equal(fresh.notifications.filter(({ message }) => /trimToTokens/.test(message)).length, 1);
	assert.equal(harness.abortCalls(), 0);
});

test("deduplicates warnings when settings reload A, B, then A", async () => {
	const previousHome = process.env.HOME;
	const home = await mkdtemp(join(tmpdir(), "context-paging-warning-settings-"));
	try {
		process.env.HOME = home;
		const agentDirectory = join(home, ".pi", "agent");
		await mkdir(agentDirectory, { recursive: true });
		const harness = createHarness(null);
		for (const [tokenBudget, trimToTokens, expected] of [[64_000, 80_000, 1], [48_000, 60_000, 2], [64_000, 80_000, 2]]) {
			await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ contextPaging: { tokenBudget, trimToTokens } }));
			await emit(harness, "session_start", { reason: "reload" });
			await emit(harness, "context", { messages: [user("RELOADED_REQUEST")] });
			assert.equal(harness.notifications.filter(({ message }) => /trimToTokens/.test(message)).length, expected);
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("implicit budget-one targets do not warn and disabled high targets remain inert", async () => {
	const implicit = createHarness({ globalSettings: { contextPaging: { tokenBudget: 1 } }, projectTrusted: false });
	implicit.ctx.getSystemPrompt = () => "";
	implicit.setActiveTools([]);
	implicit.setBranch([]);
	await emit(implicit, "context", { messages: [] });
	assert.equal(implicit.notifications.length, 0);
	assert.equal(implicit.abortCalls(), 0);
	const disabled = createHarness({ globalSettings: { contextPaging: { enabled: false, tokenBudget: 64_000, trimToTokens: 80_000 } }, projectTrusted: false });
	await emit(disabled, "session_start", { reason: "new" });
	assert.equal(await emit(disabled, "context", { messages: [user("UNCHANGED_DISABLED")] }), undefined);
	assert.equal(disabled.notifications.length, 0);
	assert.equal(disabled.abortCalls(), 0);
});

test("records the raw-provenance fallback output and re-establishes accounting safely", async (t) => {
	const records = t.mock.method(ContextUsageTracker.prototype, "recordSelection");
	const prepares = t.mock.method(ContextUsageTracker.prototype, "prepare");
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const fixture = integrationFixture("completed");
	const harness = fixtureHarness(fixture);
	const first = await emit(harness, "context", { messages: fixture.input.messages }) as any;
	assert.equal(hasMarker(first.messages, "turn-old-B payload"), false);
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);
	harness.setBranchError(new Error("UNAVAILABLE_RAW_PROVENANCE"));
	const before = records.mock.calls.length;
	const fallback = await emit(harness, "context", { messages: fixture.input.messages }) as any;
	assert.equal(hasMarker(fallback.messages, "turn-old-B payload"), true, "fallback cuts toward budget, not target");
	assert.equal(records.mock.calls.length, before + 1);
	assert.equal(records.mock.calls.at(-1)?.arguments[0], fallback.messages);
	assert.deepEqual(records.mock.calls.at(-1)?.arguments[2], [], "unavailable canonical provenance is never invented");
	assert.equal(commits.mock.calls.at(-1)?.arguments[0], undefined);

	const response = assistant("FALLBACK_RESPONSE", { totalTokens: 50 });
	await emit(harness, "turn_end", { message: response });
	const next = user("AFTER_RAW_RECOVERY");
	harness.setBranch([...fixture.entries, entry("fallback-response", response), entry("after-fallback", next)]);
	harness.setContextUsage({ tokens: statusTokens(50, [next]) });
	const recovered = await emit(harness, "context", { messages: [...fixture.input.messages, response, next] }) as any;
	assert.equal(prepares.mock.calls.at(-1)?.result, undefined, "the failed projection cannot leave a mismatched measured anchor");
	assert.equal(hasMarker(recovered.messages, "turn-old-B payload"), false);
	assert.ok(commits.mock.calls.at(-1)?.arguments[0]);

	const measuredResponse = assistant("MEASURED_RECOVERED_RESPONSE", { totalTokens: 50 });
	const measuredNext = user("MEASURED_NEXT");
	harness.setBranch([...harness.branch(), entry("measured-response", measuredResponse), entry("measured-next", measuredNext)]);
	await emit(harness, "turn_end", { message: measuredResponse });
	harness.setContextUsage({ tokens: statusTokens(50, [measuredNext]) });
	await emit(harness, "context", { messages: [...fixture.input.messages, response, next, measuredResponse, measuredNext] });
	assert.equal(typeof prepares.mock.calls.at(-1)?.result, "number");
	assert.equal(harness.abortCalls(), 0);
});

test("a filtered remembered exchange clears fallback state and can rebuild the same key", async (t) => {
	const records = t.mock.method(ContextUsageTracker.prototype, "recordSelection");
	const commits = t.mock.method(ContextCutState.prototype, "commit");
	const preparations = t.mock.method(ContextCutState.prototype, "prepare");
	const fixture = integrationFixture("active");
	const harness = fixtureHarness(fixture);
	await emit(harness, "context", { messages: fixture.input.messages });
	const first = commits.mock.calls.at(-1)?.arguments[0];
	assert.ok(first);
	const filtered = fixture.input.messages.filter((message: any) => message.toolCallId !== "call-live-2"
		&& !message.content?.some?.((block: any) => block.type === "toolCall" && block.id === "call-live-2"));
	const fallback = await emit(harness, "context", { messages: filtered }) as any;
	assert.equal(hasMarker(fallback.messages, "result-live-1 payload"), true);
	assert.equal(records.mock.calls.at(-1)?.arguments[0], fallback.messages);
	assert.equal(commits.mock.calls.at(-1)?.arguments[0], undefined);
	const rebuilt = await emit(harness, "context", { messages: structuredClone(fixture.input.messages) }) as any;
	assert.equal(preparations.mock.calls.at(-1)?.result, undefined);
	assert.deepEqual(commits.mock.calls.at(-1)?.arguments[0]?.frontier, first.frontier);
	assert.equal(hasMarker(rebuilt.messages, "result-live-1 payload"), false);
	assert.equal(harness.abortCalls(), 0);
});
