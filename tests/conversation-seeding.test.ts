import assert from "node:assert/strict";
import test from "node:test";
import { selectContext, type ContextSelection } from "../src/context-policy.ts";
import type { ContextSelectionInput } from "../src/context-policy.ts";
import type { ContextCutSnapshot } from "../src/context-cut.ts";
import { appendExchange, completeTurn, pagingFixture } from "./fixtures/context-cut.ts";

const coldCutState = (cutState: ContextCutSnapshot | undefined): ContextCutSnapshot | undefined =>
	cutState ? { ...cutState, conversation: undefined } : undefined;

/** Everything a request can observe; the conversation cache itself is not observable state. */
const observable = (selection: ContextSelection): ContextSelection => ({
	...selection,
	cutState: selection.cutState ? { ...selection.cutState, conversation: undefined } : undefined,
});

const reselect = (input: ContextSelectionInput, cutState: ContextCutSnapshot | undefined): ContextSelection =>
	selectContext({ ...input, cutState });

test("a seeded conversation record produces the same selection as a cold rebuild", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation, "a cut snapshot carries conversation records");

	const seeded = reselect(fixture.input, first.cutState);
	const cold = reselect(fixture.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold), "seeding changes nothing observable");
	assert.ok(seeded.cutState?.conversation);
	assert.equal(seeded.cutState.conversation.evictedTurns, first.cutState.conversation.evictedTurns);
});

test("a seeded conversation grows as the cut advances into new completed turns", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation);
	assert.ok(first.cutState.conversation.evictedTurns >= 1, "the first cut evicted completed turns");

	const grown = appendExchange(completeTurn(fixture, "user-next"), "next-1", 30_000);
	const seeded = reselect(grown.input, first.cutState);
	const cold = reselect(grown.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold));
	assert.ok(seeded.cutState?.conversation, "an advancing cut still carries conversation records");
	assert.ok(seeded.cutState.conversation.evictedTurns >= first.cutState.conversation.evictedTurns,
		"evicted turn count never regresses");
});

test("a mismatched conversation record count falls back to the cold rebuild", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation);
	const stale = { ...first.cutState, conversation: { ...first.cutState.conversation, evictedTurns: 99 } };
	const seeded = reselect(fixture.input, stale);
	const cold = reselect(fixture.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold), "a stale seed changes nothing observable");
});

test("conversation records survive structuredClone like the rest of the snapshot", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState);
	assert.deepEqual(structuredClone(first.cutState), first.cutState);
});
