# Architecture

## Package seam

Pi loads `src/index.ts` through the package manifest.
The extension factory is the only public code seam.
Settings, the `/context-paging` command, registered tools, and the `context-paging` extension status form the supported caller interface.

## Raw branch projection

`history.ts` reads only the active session branch.
It creates immutable user items and atomic model-turn items.
A model-turn item owns its contiguous matching tool results.
Projection rejects orphaned, duplicate, and misassigned results.
A normal incomplete older exchange is an error. The newest normal incomplete exchange remains absent until it is complete.
An assistant with `stopReason: "aborted"` or `"error"` remains recoverable with zero, partial, or complete actual results.
Projection retains the original assistant and result objects and marks the turn failed. It does not synthesize results.
Failed text-only responses also remain in raw history.

## History navigation

`recovery-content.ts` creates a public recovery view without changing raw branch items.
It permits public assistant text and ordinary tool-call blocks, with provider signatures removed.
All four paging tools' calls and results stay out of recovery. Both stored call names and result names identify excluded activity.
Paging-only turns are hidden. Mixed turns retain ordinary work and assistant text.
Mixed-turn metadata is rebuilt from retained calls and results, preserving interrupted-response and restore failure status.
Thinking, redacted thinking, unknown assistant blocks, and paging calls become `null` slots.
These slots preserve original assistant content indices.
User content, tool arguments, and ordinary tool results remain exact.
The filter does not recursively remove application-owned fields or text.

A wrapper result's optional host-level `nestedCalls` record can identify an excluded outer exchange.
Classification requires `complete: true`, a nonempty call list, and paging names on every record.
Each record also needs a nonempty string ID and status `ok`, `error`, or `unfinished`.
The shared call-ID policy excludes the outer call and result together, including in notices and emergency output handles.
It does not inspect wrapper scripts or tool-specific `details.calls` previews.
Mixed, missing, incomplete, empty, or malformed required records leave the wrapper readable.
Nested metadata does not store child results or output-to-call links. Mixed wrapper output cannot be split with this record.
Completeness covers nested tools, not arbitrary script computation or non-tool model work.
Older hosts without this field keep their previous behavior. No dependency update is required.

`navigator.ts` builds compact search records from this public view.
Search and previews skip the omitted slots.
Search serializes large tool output only when a query needs it.
Native image blocks contribute metadata, not base64, to search text and previews.
The navigator caches that corpus until visible history IDs change.
Browse uses stable history IDs and sequence numbers.
The navigator loads public items for internal callers. The tool boundary limits what returns to the model.

## Exact output paging

`recovery-parts.ts` selects parts from the public projection with JSON Pointer paths.
It lists individual message blocks, tool-result details, and model-turn metadata.
A root handle also covers headers and other public fields.
Selection accepts only own properties and preserves original assistant indices.
It rejects omitted assistant slots and does not permit traversal into image data fields.
Paging-only turns and excluded calls and results remain unavailable.

Image blocks become metadata with explicit attachment handles during text serialization.
Text-only values retain their exact JSON representation.
An explicit image read returns one native Pi image block. Its bytes never enter text or `details`.
The image attachment is exempt from the text limit. Normal provider image limits still apply.

`recovery-response.ts` limits the complete serialized text result to 16,384 UTF-8 bytes.
It counts `content`, `details`, metadata, and JSON escaping before return.
`recovery-loads.ts` reserves every requested ID and continuation before adding inline content.
Public items at most 4,096 serialized bytes can remain whole if the shared reply budget permits.
Larger items and items that do not fit return bounded part descriptions and explicit deferred markers.
Oversized reference metadata is also deferred without dropping its history ID.
Part lists have their own offsets and continuations when all descriptions do not fit.

`output-pages.ts` supports public part handles and the original assistant and tool-result selectors.
It returns exact JSON ranges of at most 2,000 requested UTF-16 code units, shortened for the reply byte limit.
Page boundaries never split surrogate pairs. The cursor advances by the actual returned length.
The reader uses the same recovery view as navigation and rejects paging calls and results.
Older paging replies can contain serialized private data.

No recovery tool summarizes large values.
Raw session storage and normal provider-message handling remain unchanged.

## Settings and limits

`settings.ts` resolves pure settings without filesystem access. `index.ts` reads global and trusted-project settings.
The budget defaults to `128_000`. The implicit target is `max(1, floor(tokenBudget * 5 / 8))` after budget resolution.
For the default budget, the target is `80_000`. A `64_000` budget has an implicit `40_000` target.
An explicit trusted-project target takes precedence over a global target. An inherited global target stays explicit with a lower project budget.

Both token settings accept positive safe integers. Invalid values fall through to the next trusted source, then the default.
Direct policy calls instead throw `INVALID_TOKEN_BUDGET` or `INVALID_TRIM_TARGET` for invalid values before eviction.
The existing positive-finite model-window validation remains separate.
Integral scaling and adaptive defaults use exact integer arithmetic near the safe-integer limit.

The effective budget is the smaller of the configured budget and model window, when the window exists.
The effective target is `max(1, floor(trimToTokens * effectiveBudget / tokenBudget))`.
For a target at or above the configured budget, the cut destination is the effective budget instead.
An explicit high target produces one warning per resolved budget/target pair per extension instance.
The frontier remains stable and forward-only, but this setting leaves no headroom between cuts.
Warning state survives model switches but not Pi restart. An implicit target equal to a tiny budget does not produce this warning.

## Context selection

`context-policy.ts` counts the system prompt and active tool definitions once as resident input.
Ordinary message estimates do not count outgoing system metadata a second time.
Before it applies any cut, the selector validates the original exchanges and omits interrupted assistants and their contiguous owned results.
Invalid exchanges outside the retained region still fail. Normalization keeps outgoing-only provenance aligned with retained messages.
The selector groups the remaining conversations into prefix units, completed turns, and active-turn exchanges.
The persistent active request, injected instructions, and latest valid unread tool-result exchange remain protected.
Interrupted exchanges do not receive unread-result protection.

The selector first resolves a remembered frontier in both raw history and current validated groups.
It applies that cut, then compares the calibrated retained estimate, including the frozen notice, with the effective budget.
Only an estimate above the budget triggers an advance. Equality and estimates between target and budget do not advance.
FIFO eviction removes prefix units, completed turns, then eligible active-turn exchanges toward the effective target.
Protected content can prevent the target. The protected floor is the estimate of content that cannot be evicted.
If this floor exceeds the target, one cut evicts every completed turn before any keyless-boundary adjustment.
The active request and unread trailing tool results remain protected.
Existing protected-overflow, recovery, and model-window safety rules still apply.
A failed selection commits no advance. The selector does not mutate canonical or raw history.

## Stable cut state

`context-cut.ts` stores a successful frontier and its frozen normal notice in memory.
It provides prepare, commit, and reset operations without settings, session I/O, or token accounting.
A frontier uses raw `historyId` keys and tool-call IDs where present, never array offsets or message-object identities.
`selection-history.ts` resolves these keys without changing recovery-tool lookup behavior.
Lower estimates never restore excluded units within a frontier lifetime.

A partial turn requires its last excluded model exchange as an anchor. Its user history ID is optional.
This permits custom-started turns whose request envelope has no raw user ID.
After completion, the request and surviving suffix stay intact. A later advance evicts that completed remainder atomically.
The original model anchor also identifies a custom-only remainder. It is not a keyless unit.

If FIFO ends at a genuinely keyless unit, the candidate boundary moves back to the last excluded keyed unit.
All keyless units after that boundary stay in the request. This snap never restores units beyond an already committed cut.
The snapped request includes the frozen notice and the same original-input calibration adjustment.
If it fits the budget, the keyed cut stays stable even above the target. A safe snap is not a fallback.
The next advance removes the retained keyless units first. The policy never evicts extra units solely to find a later key.

Without usable provenance, the current call uses stateless FIFO selection toward the budget, not the target.
It records the final outgoing request for accounting but commits no frontier or notice.
A fallback ends the previous frontier lifetime. Its cause is one of:

| Cause | Meaning |
| --- | --- |
| `raw-history-unavailable` | Raw history is unavailable for a new frontier. |
| `cut-key-unresolved` | A raw cut identity is missing or ambiguous. |
| `keyless-no-key` | FIFO ends at a keyless unit without an excluded keyed anchor. |
| `keyless-snap-over-budget` | The backward snap, including its notice, exceeds the effective budget. |
| `frontier-not-in-groups` | A raw anchor is absent from the current incoming or normalized groups. |

Missing anchors alone do not abort a provider call. Genuine structure and budget-safety errors retain their strict behavior.
A snap to the same remembered frontier still requires fallback if its request exceeds the budget.
These stateless calls cannot promise prefix stability.

## Provider-backed usage

`context-usage.ts` links a successful provider response to the exact selected request snapshot.
It matches that snapshot against the projected persistent session and separates outgoing-only instructions.
It subtracts the full persistent tail from Pi's status total, including system updates absent from outgoing messages.
Resident prompt and tool schemas contribute once. Weak caches reuse message fingerprints and estimates.
When no valid response anchor exists, selection uses the heuristic fallback.
Calibration uses the original incoming snapshot, before any remembered cut.
`context-calibration.ts` separates positive undercount into resident overhead and costs assigned to measured persistent messages.
A single provider total cannot identify the fixed overhead exactly. The first observation allocates a proportional share to resident input.
Later observations can lower this overhead estimate. A larger total does not raise the fixed overhead floor.
The remaining undercount scales the measured persistent request and its successful response.
Outgoing-only instructions and notices keep their local estimates. Restored history and new messages also keep their local estimates.
The tracker supplies these costs in the original message order. Normalization and eviction remove each message's assigned cost.
The selector does not transfer the removed cost to the protected request.
When heuristics overestimate usage, the existing additive correction remains. A mismatched status total does not reuse message weights.
These values are estimates, not exact provider token counts for the reduced request. Resident and retained-request safety checks still apply.
The final outgoing request is recorded only after successful selection, including stateless provenance-fallback calls.
Accounting fallback alone does not reset cut state.

## Read-only session stats

`stats.ts` reads all raw session entries through `getEntries()`, not the active or paged projection.
File metadata supplies the actual saved byte count. An absent or unreadable file produces `unavailable`.
Pi's message estimator counts saved text, summaries, and context-edit replacements across all branches.
The estimate includes originals and replacements because the session file retains both.
Opaque signatures and other metadata contribute to bytes, not estimated message tokens.

`index.ts` records the latest successful selection estimate without changing usage calibration or cut state.
A successful response replaces this estimate with `input + cacheRead + cacheWrite`. Output is excluded.
Lifecycle invalidation clears the transient count. After resume, the latest saved assistant on the active branch can supply measured input.
A compaction, branch summary, or model-change boundary prevents reuse of an older response count.
The input row describes the latest conversation request, not the context for the next request after its response.

Cache totals sum each saved usage record once across all branches.
Records include assistant responses, tool results with usage, warming entries, compaction, and branch summaries.
Missing, invalid, or unsafe counters make the affected total unavailable.
Explicit zero cache counters remain zero when the record contains other measured token counts.
A record with only zero or missing counters supplies no measurement.
The totals describe recorded usage, not unrecorded calls or provider invoices.

The command reports the effective budget, capped by the positive-finite model window. A disabled budget shows `inactive`.
The UI notification does not enter model context or saved history.
The stats action does not refresh navigation, reset accounting, publish footer status, or call a provider.

## Paging notices

A transient paging notice appears before retained canonical messages after eviction.
The notice reports the effective budget and gives stable recovery references.
References identify recoverable evicted items and ordinary tool results, not excluded paging activity.
When no evicted item is recoverable, the notice omits specific handles.
The raw eviction boundary remains independent of these references.
Normal selection reuses its exact content and timestamp until a frontier advance or reset changes its references, or a resize changes its copied conversation.
The notice contributes to both the budget trigger and the cut destination. It is not written into stored session history.

`paging-notice.ts` builds the notice text and its copied conversation.
The notice copies each evicted user message and the final public-text reply of the newest 3 evicted turns, with their history IDs.
Turns evicted at earlier cuts come from completed turns whose request the retained view no longer holds.
Partial-turn and prefix evictions add nothing, because their request stays in context. Without raw history provenance, the notice has no conversation section.
The section fits the smallest of 32,000 code units, 10% of the effective budget at 4 characters per token, and the room left once every evictable unit is gone.
Entries are chosen newest first and shown oldest first. Each entry is clipped to 6,000 code units and names the exact part that holds the full text.
The selector rebuilds the notice only when the evicted record or recovery key changes, and it does not cache rebuilt notices.
When a remembered cut leaves nothing to evict and its frozen notice no longer fits, the selector resizes the copied conversation before it rejects the request.
The cut state keeps the resized notice until the frontier advances.

For append-only history and stable resident input, ordinary requests preserve the previous outgoing request as a prefix between advances.
This guarantee includes the completion of a partial turn. It excludes other extensions' message edits and non-append input changes.
Protected-overflow replaces the leading notice. Recovery also replaces recoverable tool-result payloads.
Oversized unread paging results receive short exclusion notices, not unreadable recovery handles. Their live call/result pairing remains intact.
Entry into or exit from these modes can change the prefix without a frontier advance.
When normal paging resumes, its frozen notice returns unchanged. Part 1 does not make every provider call append-only.

## Lifecycle

`index.ts` resolves global and trusted-project settings at session start.
The `/context-paging on|off|status|stats` command keeps an optional enabled override in memory.
No arguments show the current state. Invalid arguments show usage without changing state.
Paging, recovery tools, trim-target warnings, and automatic-compaction cancellation use the same effective enabled state.
An actual enabled-state change resets cut state and accounting. Repeated choices and status queries do not reset either.
Every `session_start` clears the override before settings load, including new sessions, resumes, forks, and reloads.
Branch navigation, model changes, and compaction do not clear the override.
The command does not write settings or session entries.

When `ctx.hasUI` is true, the extension publishes `isEnabled()` with `ctx.ui.setStatus("context-paging", text)`.
The text is exactly `paging on` or `paging off`, without ANSI styling.
Custom footers read the value from `footerData.getExtensionStatuses()`.
Session start publishes the status after settings resolution.
If settings load throws, the extension publishes the disabled fallback status. The settings error still propagates. Every `on` or `off` command publishes the effective status, including repeated choices.
Status queries, stats queries, and invalid arguments leave the status alone.
Session shutdown clears only this status key. Headless sessions skip these UI calls.

It refreshes projected history after turns and session-tree changes.
It reuses the navigator until the visible branch IDs change.
The `context` event prepares usage from the original request, applies the selector, records the outgoing snapshot, and commits successful cut state.
The `turn_end` event records response usage.
Successful `session_start` events cover new sessions, resumes, and forks. Successful `session_tree` events cover branch navigation.
These events reset cut state and accounting. Every actual `model_select` resets both, in either window-size direction.
Successful `session_compact` events and newly projected compaction or `context_edit` entries also reset both.
One `context_edit` is an exception: Pi's retry edit that omits a failed or aborted assistant response.
That response was never sent, so the cut stays. The edit clears accounting only, because Pi's usage status then estimates the whole projection until the next measured response.
The entry module deduplicates an event and its later saved-entry notification, so they cannot reset a newly established frontier twice.

Missing raw frontier keys clear old cut state. Valid current provenance can establish a fresh cut without a provider abort.
Canceled branch, fork, session-switch, and compaction attempts do not reset a cut.
A manual-compaction attempt clears accounting, but its cut survives until successful invalidation.
The extension cancels threshold and overflow compaction while paging is enabled. Manual compaction remains available.
On Pi restart, in-memory cut and warning state disappear. No frontier is restored from stored session entries.

## Failure behavior

A settings read error disables paging for the session.
A history-navigation error does not stop context selection.
A context-selection error aborts the provider request and preserves its original messages.
Recovery tools reject execution while paging is disabled.

The resident-only precheck reports `RESIDENT_INPUT_TOO_LARGE` with `Resident input estimate`.
After legal eviction, the final retained-request check uses `Resident and retained request estimate`.
This estimate includes the retained request and paging notice, not only resident input.
The final check uses `ACTIVE_REQUEST_TOO_LARGE` with an active turn and `RESIDENT_INPUT_TOO_LARGE` without one.
This wording change does not change the accounting, eviction, or recovery policy.

## Storage and trust

The extension does not create a second history ledger.
Stable IDs come from stored session entries.
The extension reads project settings only after Pi grants project trust.
The extension runs with the same operating-system permissions as Pi.
