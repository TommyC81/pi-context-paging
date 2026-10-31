# Conversation in the paging notice

A review of five long sessions on 2026-10-30 found that a cut evicted user instructions like any other output.
Agents then spent many turns finding them again.
In one session, the agent searched 21 times for the proposal that the active request answered.
In another session, the agent re-read the governing findings list 9 times.
Agents also treated a cut as a compaction, and one agent stopped work for 40 minutes.

## Approved behavior

When a cut advances, the paging notice includes the evicted conversation, copied from session history.
It shows each evicted user message.
It also shows the final assistant reply of the newest evicted turns.
That set includes the reply that the oldest retained request answered.
This is copied text, not a summary.

The notice states these points:

- This is context paging, not compaction, and nothing was summarized.
- The agent continues the current task. It does not stop or ask the user because of the notice.
- To recover detail, the agent first uses the conversation in the notice, then plan or notes files, then history search.

The notice still changes only when the cut advances, so prompt caching keeps working.
Raw session history, recovery tools, settings, and cut state shape do not change.

## Implementation choices

These are builder choices within the approved scope, not separate user requirements.

A fully evicted completed turn contributes its user request and its final reply.
The final reply is the last assistant message in the turn that has public text.
A turn that an extension message started contributes only its reply.
Partial-turn and prefix evictions contribute nothing, because their request stays in context.
Turns evicted at earlier cuts are found from the completed turns whose request the retained view no longer holds.

Each entry needs a recoverable history ID, and the notice shows that ID.
Without raw history provenance, the notice has no conversation section.
User text joins text blocks and shows `[image]` for each image.
Reply text joins public text blocks only, without thinking or tool calls.

Replies are kept for the newest 3 evicted turns.
Each entry is clipped to 6,000 UTF-16 code units without splitting a surrogate pair.
A clipped entry names the exact `read_context_output` part that holds the full text.
The conversation section is capped at the smaller of 32,000 code units or 10% of the effective token budget at 4 characters per token.
It also fits the room left once every evictable unit is gone, so it never makes a request fail that fits with the plain notice.
Entries are chosen newest first, then shown oldest first.
If an entry does not fit whole, it is clipped to the remaining room when at least 500 code units remain.
The notice counts the user messages it omits and says how to find them.
The notice keeps the existing most recent evicted history ID and last evicted tool-output handle.

Keep the notice text and conversation record in a focused `src/paging-notice.ts`.
`src/context-policy.ts` is already above 700 lines.
The selector rebuilds the notice only when the evicted record or recovery key changes.
The section cap bounds each rebuild.
Do not add file lists, an agent notes area, settings, or dependencies.

## Verification

Write selector tests first and watch them fail before changing production code.
Cover evicted user messages, newest replies, the reply that the oldest retained request answered, and earlier-cut turns after a remembered frontier.
Cover partial-turn evictions, missing provenance, images, clipping, the section cap, and omitted counts.
Check that the notice is unchanged between cut advances and that estimates still count the notice.
Update eviction assertions that inspect every outgoing message so that they check retained canonical messages instead.
Run the privacy, paging-exclusion, cut, and extension tests, then the complete `npm run check` command.
Review the notice wording directly instead of testing static text.
