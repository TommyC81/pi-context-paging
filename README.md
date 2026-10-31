# pi-context-paging

`pi-context-paging` gives Pi a rolling context window with a fixed token budget.
When the window is full, the oldest history leaves the window.
The stored session history does not change.
The model gets tools to find that older history and load its public content again as exact text.
Private assistant blocks remain in stored history, but recovery tools do not return them.
The extension never summarizes history.

## The problem with compaction and handoff

Every model has a context window with a fixed size.
A long session fills this window.
Then Pi must make room before it sends the next request.

Pi usually makes room with compaction.
Compaction keeps a small recent part of the history as it is. By default, this part is 20,000 tokens.
In a busy session, that part covers only the last few steps.
The model writes a summary of everything before that part. The summary replaces those messages.

A handoff is similar.
You ask the model for a summary note, then you start a new session from that note.

Both methods lose detail.
A summary keeps the main points. It drops exact file paths, error text, tool output, and the state of unfinished work.
The lost detail is often the detail that the model needs most.
The work from the last hour has the files the model read, the errors it saw, and the decisions it made.

Most of that work is older than the small recent part, so the summary replaces it.
After compaction, the model continues from the summary and not from the real history.
The model cannot get the lost detail back.

Compaction also happens at a bad time.
When the window is almost full, Pi starts compaction. This is often in the middle of a task.

A full window also makes the model worse.
When the context is long, many models give worse answers. This happens well before the window is full.
People call this part of the window the dumb zone.
Pi waits for an almost full window before it starts compaction.
As a result, the model works in the dumb zone for a long time before each compaction.

## The idea: a rolling window, not a summary

The session history is like a long document.
The model reads this document through a window.
The window shows only the most recent part.
When the document grows, the window moves forward.
Nothing is cut from the document.

The extension works like this:

- Pi stores the full session history on disk. The extension never changes this history.
- The extension sends the model only the most recent history that fits in the token budget. This part is the rolling window.
- When a request is larger than the budget, the extension removes the oldest history from the window. That history stays in the stored session.
- The model gets a paging notice at the start of the window. The notice says that older context left the window, and how to get it back. It also copies the removed user messages and the newest removed replies.
- The model has four recovery tools. They search, browse, and load the older history as exact text.

This is better than compaction or handoff for these reasons:

- **The model stays out of the dumb zone.** The extension keeps requests at or below the token budget. If you set the budget below the point where the model gets worse, the model always works with a short context.
- **The recent context stays exact.** The newest messages and tool results stay in the window as stored.
- **The oldest history leaves first.** The extension removes whole turns from the start of the history. It does not choose by content.
- **Nothing is lost from storage.** The complete session stays stored. The model can recover public content from older items as exact text.
- **Old detail returns on request.** A summary must guess in advance which details matter. A recovery tool returns the exact public content that the model asks for.
- **There is no surprise compaction.** The extension cancels automatic compaction while it is enabled. You can still compact by hand.

One behavior is different from compaction.
The model does not see most older history until it asks for it.
The paging notice copies the removed user messages and the newest removed replies. It does not summarize them.
The notice also tells the model how to load the rest.
The model decides when to search.

## Install

From npm:

```sh
pi install npm:@rochecompaan/pi-context-paging@0.3.11
```

From the GitHub release tag:

```sh
pi install git:github.com/rochecompaan/pi-context-paging@v0.3.11
```

After installation, restart Pi.

## Settings

The extension is enabled by default.
The default token budget is 128,000 tokens.
The default trim target is 80,000 tokens.
To change these values, add this object to `~/.pi/agent/settings.json` or to a trusted project `.pi/settings.json`:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000,
    "trimToTokens": 80000
  }
}
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `enabled` | Set this to `false` to stop paging and the recovery tools. | `true` |
| `tokenBudget` | The largest request size, in estimated tokens. A larger request causes a cut. | `128000` |
| `trimToTokens` | The request size that a cut trims to. | 5/8 of the budget |

A trusted project setting takes precedence over the global setting.
The extension ignores project settings in untrusted projects.

To keep the model out of the dumb zone, set `tokenBudget` below the context size where the model gets worse.
If your model gets worse before 128,000 tokens, lower the budget.

If you omit `trimToTokens`, the default is `max(1, floor(tokenBudget * 5 / 8))`.
A 64,000-token budget therefore has a 40,000-token default target.
The effective budget never exceeds the context window of the active model.
If the model window is smaller than the budget, the extension scales the target by the same ratio.
The minimum target is one token.

Both token settings accept positive safe integers only.
The extension does not convert strings, fractions, or other invalid values.
An invalid project value does not apply. The extension then uses the global value, or the default.
If a project sets a lower budget, an explicit global target stays explicit.

If you set a target at or above the budget, there is no headroom between cuts.
The extension keeps stable cuts, but it trims to the effective budget instead.
It warns once for each budget and target pair in one Pi process.
A restart can repeat the warning.

## Session command

Use `/context-paging` to change paging for the current session only:

| Command | Effect |
| --- | --- |
| `/context-paging on` | Enable paging and recovery tools. |
| `/context-paging off` | Disable paging and recovery tools. Pi uses its normal context and automatic compaction behavior. |
| `/context-paging` or `/context-paging status` | Show whether paging is enabled or disabled. |
| `/context-paging stats` | Show saved history size, latest request input, and whole-session cache totals. |

The command does not change saved settings or stored session history.
A state change clears the remembered cut point and token accounting.
Repeating `on` or `off` does not clear this state.

Branch navigation, model changes, and manual compaction keep the session choice.
A new session, a resume, a fork, or an extension reload restores the saved settings.

### Session stats

The `stats` action is available from version 0.3.2.

Run `/context-paging stats` to show a read-only report.
These example values are illustrative:

```text
Context paging: on

SESSION — complete saved history
  Stored size          8.42 MiB
  History tokens       ~684,230

CONTEXT — latest model request
  Input tokens         82,412
  Paging budget        128,000   (64.4% used)
  Model window         272,000

CACHE — whole-session totals
  Tokens read          6,421,880
  Tokens written       384,000
```

- Stored size is the actual session-file size, including metadata. In-memory sessions have no stored-file measurement.
- History tokens use Pi's estimates for all saved messages, summaries, and edit replacements. This includes inactive branches and paged-out history.
- Input tokens describe the latest conversation request, not the next request after its response. The provider count includes cached input and excludes output.
- Without complete provider usage, the latest outgoing paging selection supplies an estimate. This estimate includes the system prompt, tool definitions, and paging notice.
- `~` marks estimates. Missing or invalid measurements show `unavailable`, not zero.
- Cache totals include saved usage from all branches, tool results, warming calls, compaction, and branch summaries. Each saved usage record contributes once.
- One missing cache component makes its whole-session total unavailable. An all-zero usage record is not a measurement.

The effective budget never exceeds the model window. With paging off, the budget shows `inactive`.
Cache traffic can exceed stored history because requests reuse the same input.
These totals describe Pi's saved usage, not a provider invoice or usage that other extensions do not save.
The stats action does not change paging state, write session entries, or call a provider.

### Footer status

In UI sessions, the extension publishes its effective state under the `context-paging` status key.
The text is exactly `paging on` or `paging off`, without ANSI styling.
Custom footers can read this value from `footerData.getExtensionStatuses()`.

The status reflects saved settings at session start and the current session choice after every `on` or `off` command.
Repeated choices also publish the status.
If settings fail to load, the status shows `paging off`.
Session shutdown removes the status key. Headless sessions do not call the status UI.

## Recovery tools

| Tool | Purpose |
| --- | --- |
| `search_history` | Find compact references to history by text, file, tool, or failure state. |
| `browse_history` | Move backward, forward, or around one history item. |
| `load_history` | Load public history items by stable ID. |
| `read_context_output` | Read public text parts, list more parts, or request one native image attachment. |

Search and browse return compact references to public content.
Load and read preserve exact public text, tool-call data, and ordinary tool results.
Images use metadata and explicit attachment requests instead of base64 text.
The tools never summarize.
When paging is disabled, the tools refuse to run.

Search indexes actual public text, including words after newlines.
It ignores punctuation around identifiers but preserves separators inside identifiers and paths.
A text query returns a short excerpt around the first matching term in the public search text.
This can show matching tool output instead of the start of the assistant response.
An ellipsis (`…`) marks a clipped end.
Browse previews and empty-query search previews still start at the beginning.

The `tools` filter matches any listed tool name.
For example, `tools: ["bash", "codemode"]` matches a turn that used either tool, or both.
An omitted or empty list adds no tool restriction.
The text query and other filters still apply.
The `files` filter requires every listed file.

With `load: true`, `search_history` returns all requested `references` and loads at most three `items`.
The `unloadedHistoryIds` array lists the other matches in search order.
Use `load_history` to load those IDs, at most three per call.

### Reply limits and large items

Every text reply has a 16 KiB limit, measured as serialized UTF-8 bytes.
The limit covers the complete tool result, including metadata and JSON escaping.
Replies put everything in `content` and leave `details` empty, so no copy uses up the limit.
Requested items load whole, smallest first, while they fit the shared reply budget. The reply keeps the requested order.
A large item does not prevent a smaller item from loading. Items with images stay deferred.

A deferred item contains `id`, `kind`, `deferred: true`, and part descriptions with read handles.
It also contains `totalParts`, `nextPartOffset`, and a `readParts` handle.
If `nextPartOffset` is not `null`, pass `readParts` to `read_context_output` to get the next descriptions.
Repeat with the returned `nextOffset` until it is `null`.
To list every part from the start, use `mode: "parts"` with `offset: 0`.
Oversized reference metadata becomes `{ historyId, detailsDeferred: true }`. The ID remains loadable.

Each part handle contains a `historyId` and a `part` path into the public item.
For example, this call reads a stored user string:

```json
{"historyId":"abc123","part":"/userMessage/content"}
```

Default text mode returns two text blocks.
The first block is a JSON header. For a 40,000-character user message, the first header is:

```json
{"historyId":"abc123","part":"/userMessage/content","format":"text","offset":0,"nextOffset":16092,"totalCharacters":40000,"next":{"historyId":"abc123","part":"/userMessage/content","offset":16092}}
```

The second block is the page itself, without JSON escaping. An empty page has no second block.
The format is `text` for strings and for text blocks that have only `type` and `text`. Their pages contain the plain text.
Other parts have the format `json`. Their pages contain exact JSON.
Offsets count UTF-16 code units, as JavaScript string offsets do.
A page fills the byte limit unless `limit` is smaller. The largest `limit` is 16,384 code units.
Pages never split a Unicode surrogate pair. If the next character needs two code units and `limit` is one, increase `limit`.
Each header repeats `historyId` and `part`, so `historyId` can have at most 128 characters and `part` at most 512. Handles from the extension are much shorter.
While text remains, the header has `next`, the exact arguments for the next read. Pass it unchanged to recover the full value without gaps.

The older `source: "assistant"` and `source: "toolResult"` selectors still work.
Without `contentIndex`, `source: "assistant"` reads the turn's only public text block. A turn without text blocks and with only one public block reads that block.
Without `toolCallId`, `source: "toolResult"` reads the turn's only public tool result.
In other cases, the error lists the public choices. An unknown part gives an error that lists the item's public parts.
These lists shorten long values and omit choices past a size limit. Use `mode: "parts"` for the complete list.
Do not combine these selectors with a `part` handle.

### Images

Image parts contain metadata and a read handle with `mode: "image"`.
Pass that handle to `read_context_output` to receive one native Pi image attachment.
The image bytes do not enter text replies or search previews.
Text reads of image-containing values return image metadata with attachment handles instead of base64.

The 16 KiB limit applies to the image response's text and metadata, not its native attachment.
Each request returns at most one image. Normal provider image limits still apply.
Image mode does not accept text-page offsets or limits.
This feature does not export original files, resize images, or crop them.

### Private assistant content

Recovery tools exclude assistant thinking blocks, redacted thinking payloads, and provider signatures.
Search does not index these values, and previews do not show them.
Only public assistant text and ordinary tool-call blocks enter the recovery view.
Unknown assistant block types also stay out of this view.

All four recovery tools exclude their own calls and results from search, browse, load, and output pages.
Turns with only paging activity do not appear in recovery.
Mixed turns retain their public assistant text and ordinary work.
Their tool, file, and failure filters describe only the retained work, including any interrupted response.

Wrappers such as `codemode` also stay out of recovery when Pi records a complete, nonempty list of exclusively paging-tool calls.
This uses the host's `nestedCalls` record, not script text or tool-owned previews.
Mixed wrappers and wrappers with missing, incomplete, empty, or malformed required records stay readable.
Pi records nested tool metadata, not separate child outputs. Paging output inside mixed wrappers therefore remains readable.
The record does not describe arbitrary script computation or non-tool model work.

Loaded assistant content uses `null` for each omitted block.
These slots preserve the original array indices.
The page reader uses those original `contentIndex` values and rejects reads of omitted blocks.
It also rejects calls and results from the four recovery tools. Older saved replies can contain private assistant data.
The original history item remains the source for public output.

This filter does not change stored history or the normal provider-message format.
It does not remove matching words or fields from user text, tool arguments, or ordinary tool results.
The filter reduces accidental internal-reasoning extraction, but provider safeguards can still reject a request.
Previously returned private content can remain in an existing session.
A new session avoids replay of those older tool replies.

## How the extension selects the window

**Measurement.** If the provider reported token usage for the previous response, the extension uses that usage.
Otherwise, it estimates the request.
The system prompt and tool definitions count once.

**Validation.** Before any cut, the extension validates the request.
It does not send aborted or errored assistant exchanges to the model.
Those exchanges and their actual results stay in the stored history and the recovery tools.

When a session loads or changes branches, paging also treats saved tool calls with missing results as interrupted.
It excludes those incomplete exchanges from model requests but keeps their recorded messages and actual results available through recovery tools.
It does not change session files or add missing results.
New tool calls in a live session still require results.
Duplicate, mismatched, and orphan results still raise errors.

**The cut point.** A request within the budget needs no cut and no notice.
When a request exceeds the budget, the extension removes the oldest history until the request is at or below the target.
The size of the paging notice counts as part of the request.
The extension then remembers the cut point (the architecture document calls it the frontier).

The extension reuses the same cut point and the same notice until the request exceeds the budget again.
A request that is equal to the budget, or between the target and the budget, does not move the cut point.
A lower estimate never brings removed history back.

**The paging notice.** The notice says that this is context paging, not compaction, and that nothing was summarized.
It tells the model to continue the current task.
It gives the most recent removed history ID and a handle for the last removed tool output.

The notice also copies the removed conversation from the stored session.
It shows each removed user message and the final reply of the 3 newest removed turns.
The final reply is the last assistant message in the turn with public text. Thinking and tool calls stay out.
Turns that are only partly removed add nothing, because their request stays in the window.
Each entry shows its history ID.
An entry longer than 6,000 characters (UTF-16 code units) is clipped. The clipped entry names the `read_context_output` part with the full text.

The copied conversation is at most 32,000 characters, or 10% of the budget at 4 characters per token if that is smaller.
It also fits in the room that is left when every removable turn is gone.
A request that fits with the plain notice therefore never fails because of the copied conversation.
When user messages do not fit, the notice counts them and says how to find them.
If the stored history cannot be read, the notice has no copied conversation.

One case changes the notice without a new cut.
If a later request exceeds the budget and no removable history is left, the extension shrinks the copied conversation before it reports an error.
It keeps the smaller notice until the next cut.

**Why the cut point is stable.** The same cut point means that each request starts with the same messages as the last one.
This keeps the provider prompt cache useful between cuts.
The guarantee holds for ordinary append-only history with stable resident input.

Two special cases exist for very large tool results.
When the newest tool result is too large for the budget, the extension keeps it in full for one call. It also changes the notice.
When it is too large for the model window, the extension replaces it with a recovery reference.
These two cases, resets, and message edits by other extensions can change the start of the request.

**Protected content.** The extension never removes the active request or the newest unread tool results.
Protected content can keep the request above the target.
That is not an error while the request is within the budget.
If the protected content alone is above the target, one cut removes every completed turn.

**Whole units.** The extension removes whole completed turns, oldest first.
Inside the active turn, it can remove older model exchanges, but never the current request or the unread tool results.
A partly cut turn keeps its request and the exchanges that survived the cut.
A later cut removes that completed remainder as one unit.

**Stable keys.** Each cut point uses stable history IDs, not positions in a list.
A few history items have no stable key.
If a cut ends at such an item, the cut point moves back to the last removed item that has a key.
The items after that point stay in the request.
If the request and the notice together fit the budget, this moved-back cut stays stable.

Two cases have no stable cut point.
The first case is a missing or ambiguous history key.
The second case is a moved-back cut that does not fit the budget.
In these cases, the extension selects history for that one request only, toward the budget.
It does not remember that selection.
It never removes extra history only to find a key.

**Resets.** These events reset the cut point: a session change, branch navigation, a fork, compaction, a context edit, or a model switch.
The exception is the edit Pi saves before it retries a failed request, which only removes the failed response.
A Pi restart also loses the cut point, because the cut point lives only in memory.
Canceled operations do not reset it.
A fallback in token accounting does not reset it either.

**Error wording.** After a legal cut, `RESIDENT_INPUT_TOO_LARGE` can report `Resident and retained request estimate`.
That wording means the retained request and the paging notice, not only resident input.
The resident-only precheck still reports `Resident input estimate`.
The wording does not change the accounting or the recovery policy.

**Compaction.** The extension cancels automatic compaction while it is enabled.
Manual compaction remains available.
A successful manual compaction resets the cut point.

Read [the architecture document](docs/architecture.md) for module and lifecycle details.

## Changes in 0.3.11

- `load_history`, and `search_history` with `load: true`, return items whole, smallest first, while they fit the 16 KiB reply. Before, every item over 4 KiB came back as parts.
- `read_context_output` text mode returns a JSON header block, then the page as a second block. Strings and text blocks with only `type` and `text` read as plain text without JSON escaping. Other parts read as exact JSON.
- Pages fill the 16 KiB reply instead of stopping at 2,000 characters. While text remains, the header has `next`, the exact arguments for the next read. `limit` is optional, up to 16,384.
- Without `contentIndex` or `toolCallId`, the `source` selectors read the only matching public block or tool result. Ambiguous selectors and unknown parts give errors that list the public choices.
- `historyId` can have at most 128 characters and `part` at most 512, because every page header repeats them.
- Recovery replies leave `details` empty. Everything is in `content`.
- Recovery handles in the paging notice no longer set `offset` and `limit`.

## Changes in 0.3.10

- The paging notice copies the removed conversation from the stored session: each removed user message and the final reply of the 3 newest removed turns. This is copied text, not a summary. A clipped entry names the part that holds the full text.
- The notice says that paging is not compaction, and tells the model to continue the current task.
- The copied conversation uses only the room left when every removable turn is gone, so it never makes a request fail that fits with the plain notice. A remembered notice shrinks when a later request leaves no history to remove.
- Every recovery reply has a 16 KiB limit. Large items return part handles that `read_context_output` reads exactly. Images return metadata and at most one native attachment per request, not base64 text.
- The four recovery tools exclude their own calls and results from search, browse, load, output pages, and notices. This includes wrappers such as `codemode` that called only paging tools.
- The `search_history` `tools` filter matches any listed tool.
- Text-query search previews show an excerpt around the first matching term.

## Changes in 0.3.9

- Session loads and branch changes recover saved tool exchanges with missing results after a crash, even when the assistant still reports `toolUse`.
- Paging excludes those incomplete exchanges from model requests but keeps their original messages and actual results available through recovery tools.
- Live-session calls still require results. Duplicate, mismatched, and orphan results still raise errors.
- Recovery does not change session files or add missing results.

## Changes in 0.3.8

- When a provider request fails, Pi retries it and saves an edit that removes the failed response. Paging now keeps its cut point after that edit, because the failed response was never sent.
- After that edit, paging ignores Pi's usage status until the next successful response, because Pi then estimates the whole session instead of reporting provider usage.
- Every other context edit and every compaction still resets the cut point.

## Changes in 0.3.7

- Search matches public text after newlines and ignores punctuation around identifiers.
- Loaded searches retain unloaded matches in `references` and `unloadedHistoryIds`, with at most three loaded items per call.
- The recall harness restores each question into a separate conversation so that earlier answers cannot influence later probes.
- Reports separate token use, cache use, catalog cost estimates, response time, and total task time.
- Offline restoration tests and explicit approvals guard live pilots and batches.
- The README records the isolated-probe pilot results. Evaluation code and private artifacts stay outside the npm package.

## Changes in 0.3.6

- The repository adds a development-only recall harness with fresh baseline and paging conversations before and after native compaction.
- The README records the preliminary pilot results and links to the evaluation guide.
- Evaluation code and private run artifacts stay outside the npm package.
- Production paging code is unchanged from 0.3.5.

## Changes in 0.3.5

- Paging removes the calibrated token cost of consumed recovery results when it removes those results from a request.
- Positive provider undercount uses separate resident and measured-message estimates instead of one permanent offset.
- Restored history, transient instructions, and paging notices keep their local estimates.
- The token budget, resident checks, active request checks, and newest tool exchange protection stay unchanged.
- Stored session history stays unchanged.

## Changes in 0.3.3

- Recovery tools exclude assistant thinking, redacted thinking payloads, and provider signatures from search, previews, loads, and output pages.
- Loaded assistant content uses `null` slots for omitted blocks. Original `contentIndex` values remain unchanged.
- Output pages reject private assistant blocks and saved recovery-tool replies that can contain older private data.
- Public text, tool-call data, and ordinary tool results remain exact. Stored history and normal provider-message handling stay unchanged.
- If an existing session still triggers a provider safeguard after the upgrade, start a new session. Older tool replies remain stored.
- Provider safeguards can still reject requests. This release prevents structured private content from entering new recovery replies.

## Changes in 0.3.2

- `/context-paging stats` shows a read-only session report with paging on or off.
- Saved history includes the actual file size and estimated tokens across all branches, including paged-out content.
- Latest request input uses provider usage or a marked paging estimate. The report also shows the effective budget and model window.
- Whole-session cache totals include saved usage from responses, tools, warming calls, compaction, and branch summaries.
- Missing, invalid, unsafe, or default-zero measurements show `unavailable`. Measured zero cache counts remain zero.
- Stats do not reset cuts, change paging, write history, or call a provider. Recovery and footer status stay unchanged.

## Changes in 0.3.1

- The `context-paging` extension status reports the effective state as plain `paging on` or `paging off` text.
- Session start and every `on` or `off` command publish the status, including repeated choices.
- A new session restores the saved state in the status. A settings read error publishes `paging off`.
- Session shutdown removes the status. Headless sessions do not call the status UI.
- Paging, recovery, and compaction behavior stay unchanged.

## Changes in 0.3.0

- `/context-paging on` and `/context-paging off` change paging for the current session only.
- `/context-paging` and `/context-paging status` show the current state.
- The command leaves saved settings and stored history unchanged.
- A new session, a resume, a fork, or an extension reload restores saved settings. Branch navigation keeps the session choice.
- Actual state changes clear the remembered cut point and token accounting. Repeated choices and status queries keep both.

## Changes in 0.2.1

- The README now explains context paging in simple English. It describes why compaction and handoff lose recent detail, and how a bounded window keeps the model out of the dumb zone.
- The runtime source is unchanged from 0.2.0.

## Changes in 0.2.0

- The cut point and the paging notice stay the same between budget crossings. A lower estimate does not bring removed history back.
- `trimToTokens` defaults to 5/8 of the budget. Token settings accept positive safe integers and scale for smaller model windows.
- Custom-started turns and partly cut turns keep valid cut points after completion.
- A cut point without a stable key moves back only within the budget. Missing or ambiguous keys use stateless selection toward the budget.
- Successful lifecycle changes reset the cut point. Canceled navigation keeps it.
- Outgoing-only instructions no longer hide an earlier valid turn anchor.
- Error wording now separates resident input from the retained request and the paging notice.

### Earlier fixes in this release

- Provider-backed accounting handles restored raw history and outgoing-only instructions. It does not count resident input twice.
- Raw history keeps interrupted turns and their actual results. Provider requests omit those exchanges after the extension validates their results.
- Normal incomplete exchanges and malformed results keep strict validation.

This release does not change the accounting further.
The extension does not yet let the model choose which history to remove.

## Development

Requirements:

- Node.js 22.19.0 or newer
- npm

Run all checks:

```sh
npm ci
npm run typecheck
npm test
npm run check:package
```

Run the performance benchmark:

```sh
npm run bench
```

## Recall evaluation

The development-only [recall harness](docs/evals/full-budget-recall.md) compares baseline Pi with paging.
Stages A and B use separate source conversations.
Each question runs in its own restored conversation, so that sibling probes cannot share answers or recovery results.
The harness records token use, cache use, catalog cost estimates, response time, and total task time.
Catalog estimates are not billed costs.

From a source checkout, run the offline preview after `npm ci`:

```sh
npm run eval:recall -- --dry-run
```

The preview sends no provider requests.
Live pilots and batches each require separate user approval.
Read the evaluation guide for preparation, limits, and result interpretation.

The isolated-probe pilot on October 7, 2026 used `openai-codex/gpt-6-luna` with `xhigh` reasoning.
Its native context window was 272,000 tokens. Paging used a 128,000-token budget and an 80,000-token trim target.
The harness source tree is included in [`f10f216`](https://github.com/rochecompaan/pi-context-paging/commit/f10f2161a8e9c868fd8dc9474b0acab288293bb4).

| Stage | Baseline known facts | Paging known facts |
| --- | --- | --- |
| A: before baseline compaction | 5/5 | 5/5 |
| B: after baseline compaction | 0/5 | 5/5 |

All 24 probe forks finished, both stage gates passed, and all four unknown controls passed.
Each correct paging answer had matching recovery-tool evidence, including both revised decisions.

These results are preliminary. One matched pair per stage does not establish general recall, speed, or cost advantages.
Sibling probes share source preparation and are not independent session samples.
The harness does not inspect opaque model reasoning.
Earlier shared-probe scores are not directly comparable with this isolated-probe pilot.

## Upgrade and removal

Upgrade installed packages:

```sh
pi update --extensions
```

Remove the package:

```sh
pi remove npm:@rochecompaan/pi-context-paging@0.3.11
```

## License

MIT
