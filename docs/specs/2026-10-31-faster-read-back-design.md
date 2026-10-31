# Faster history read-back

The 2026-10-30 review of five long sessions found that reading history back took too many calls.

- `load_history` and `search_history(load:true)` deferred 100 of 239 loaded items. Of the 99 deferred items with a known size, 63 serialized to at most 7.5 KB and 25 more to at most 15 KB.
- `read_context_output` pages held at most 2,000 characters of JSON inside a JSON string. Most first reads (39 of 47) covered 2,000 to 6,000 characters, so they needed two or three calls. Some reads took 21 and 25 calls.
- 6 of 109 reads failed: 3 omitted `contentIndex`, 1 omitted `toolCallId`, and 2 named an assistant block that is not public.

Two causes add up. Each reply copied its whole payload into `details`, and the 16 KiB limit counts `content` and `details` together. The content text was also JSON inside JSON, so the limit counted it with two levels of escaping.

## Approved behavior

- Return a single requested item whole when it fits in the 16 KiB reply.
- Return string parts as plain text, not JSON inside JSON.
- Size pages by the byte limit instead of the 2,000-character cap.
- Default a missing `contentIndex` or `toolCallId` when only one choice exists.

The 16 KiB limit on the complete serialized tool result stays. Tool names, selectors, part pointers, image attachments, the three-item load maximum, and the privacy and paging exclusions do not change. Raw history does not change.

## Implementation choices

These are builder choices within the approved scope, not separate user requirements.

Recovery replies keep everything the model reads in `content` and leave `details` undefined.
No code, renderer, or evaluation reads these `details`, and the copy halved the room for content.

`load_history` no longer has a 4 KiB limit for whole items.
After it reserves every ID and continuation handle, it makes items whole from the smallest to the largest while the reply fits.
Items keep their requested order in the reply, and a large item still cannot block a smaller one.
Items that contain images stay deferred. One part description still has a 4 KiB limit.

A text-mode read returns two text blocks.
The first block is a JSON header with `historyId`, the resolved `part` pointer, `format`, `offset`, `nextOffset`, and `totalCharacters`.
When more text remains, the header also has `next`, the exact arguments for the next read.
The second block is the page itself, not escaped. An empty page has no second block.
The format is `text` when the selected value is a string, or a text block with only `type` and `text`. Pages then slice that string.
Every other value has the format `json`. Its pages slice the same image-safe JSON as before.
Legacy assistant reads of text blocks therefore count offsets in the plain text.

`limit` is optional. Without it, a page fills the byte budget. The maximum is 16,384 UTF-16 code units, which a 16 KiB reply cannot exceed.
Pages still never split a surrogate pair.
Part descriptions of text-format parts report the plain text's byte size and preview, and their type is `text`.

`source: "assistant"` without `contentIndex` reads the only public text block. A turn without text blocks and with only one public block reads that block. In the studied sessions, 3 of the 4 failed assistant reads named such a turn.
`source: "toolResult"` without `toolCallId` reads the only public tool result.
When several or no choices exist, the error lists the public choices.
An unknown or private part pointer gives an error that lists the item's public part pointers and suggests `mode: "parts"`.

## Verification

Write tool-level tests first and watch them fail before changing production code.
Cover a single item between 4 KiB and the reply limit loading whole, smallest-first loading of several items, plain-text pages for user strings and assistant and tool-result text blocks, JSON pages for other parts, byte-sized pages without a 2,000-character cap, exact reconstruction of ASCII, Unicode, and escaped text from `next` handles, the defaulted selectors, and the error lists.
Keep the existing bound, privacy, paging-exclusion, and image tests passing, with helpers that read `content` instead of `details`.
Run the focused recovery tests, then the complete `npm run check` command.
Replay the recorded `load_history` and `read_context_output` calls from the studied sessions through both `main` and the branch, and compare deferred items, pages to read each part in full, and the formerly failed reads.
Update the README, the architecture document, and the tool descriptions, and review their wording directly.
