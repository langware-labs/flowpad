---
id: 17d1ac70-32de-4a23-b66b-b3faa4c3ccec
title: Live frames must name their transcript entry
tags:
- breadcrumb.test.live_frame_identity.rules
description: process_entry rides the history JSON but NOT the live wire — to_xml serializes
  attributes and content only — so without a transcript-entry-id attribute an observing
  client's resume position freezes at its last history load and observe-turn replays
  every turn since.
---

# Live frames must name their transcript entry

> Ground truth. Proven by RCA on 2026-08-26. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.live_frame_identity.rules
sites:
  - rel_path: "tests/unit/test_agentic_process/test_observe_turn_after_entry_id.py"
    line: 276
    note: "FAILING? the wire lost transcript-entry-id - read this tag's rules before touching entry_to_flowdata or to_xml"
```

## Expected behavior

`observe_turn` is a PULL stream for a turn this client did not start. It takes
an optional `after_entry_id`: the client states the last transcript entry it
holds and the stream resumes strictly after it. Omit it and the stream
watermarks at open.

For that to work across more than one open, the position the client states must
**advance**. After a stream has delivered entries E5…E9, the next open must
state E9 — not whatever the pane happened to load from history ten minutes ago.

A re-open is routine, not exceptional: `useObservedTurn` closes its observation
when `busy` flips false and opens a new one for the next turn, so a chained
queue drain re-opens once per turn.

**A stream that states a position is a HANDOVER, not only a follow.** `busy`
gates whether there is a turn to follow; it does not gate whether there is
anything to send. A SHORT turn is over before the client can open at all —
`busy` reaches the client from the DEBOUNCED transcript flush, so the open loses
that race by construction — and everything the client has never seen is by then
already on disk. Such a stream must hand the backlog over and then close.

## Internals

* **`FlowData.to_xml`** (`flow_sdk/external_apis/llm/llm_drivers/flow_data.py:250`)
  builds `i`, `t`, `focus`, `part`, then every key of `self.attributes`, then the
  content. **`process_entry` is a field on the model (`:179`) that `to_xml` never
  serializes.** It is not dropped by accident at a call site — it simply is not
  part of the wire format.

* So `process_entry` reaches the client on exactly one path: the **history**
  JSON, `AgenticProcess.loadHistory` → `FlowData.fromJSON({… process_entry })`
  (`ts_sdk/src/process/agentic-process.ts:1999`). Every LIVE frame — `observe-turn`
  and the sender's own `prompt` stream — is serialized through `to_xml` and
  arrives without it.

* The WS channel is the same. The `emit_flow_data` envelope captured verbatim
  from a live backend (`ui/tests/unit/queued-turn-renders-once.test.ts:44`) carries
  `element_type`, `data_type`, `content`, `attributes` — **no `process_entry`**.

* **`lastHeldTranscriptEntryId`** (`ts_sdk/src/process/agentic-process.ts:2448`)
  is what `observeTurn` calls to fill `after_entry_id`. It scans `flowDataStream.items`
  from the tail for a transcript id. Reading only `processEntry.transcript_entry.id`
  made it structurally blind to everything live.

* **`entry_to_flowdata`** (`flow_sdk/builtin/agentic_process/cli_drivers/claude/session_history.py:130`)
  is the converter `observe_turn` imports — **unconditionally, for every worker
  type**, not just claude. It sets `process_entry` in both branches (the
  tool/operation branch and the message branch) and, before this fix, no id
  attribute in either.

* **Codex already had this right.** `cli_drivers/codex/session_history.py:277`
  stamps `frame.attributes.setdefault("transcript-entry-id", entry.id)`. Claude's
  converter was the outlier, and `historyIdentityKey`
  (`ts_sdk/src/process/agentic-process.ts:158`) already read that attribute as its
  fallback — the client half of the convention existed before the server half did.

* **The backend resume itself was never broken.** `agentic_process.py:4473`
  scans `entries_at_open` from the tail for `after_entry_id` and sets
  `emitted = index + 1`. Given a correct id it resumes correctly; given a frozen
  one it faithfully replays everything after it.

* **The liveness gate at open** (`observe_turn`, just below `_observe`) used to
  read `asyncio.create_task(_observe()) if is_turn_busy(self) else None` — so a
  not-busy open discarded the resume position it had just computed and closed
  empty. It now opens whenever the process is busy **or** `backlog =
  len(entries_at_open) - emitted` is non-zero, and passes `live=busy_at_open`:
  a backlog-only stream flushes one pass and returns. That return is load
  bearing — the PTY liveness check needs a provider marker (`turn_duration`,
  a SYSTEM row), and a stream opened after that marker was written never sees
  one, so without it the backlog stream polls forever instead of closing.

## The proven lever

Two levers, each toggled in both directions, because the defect spans both tiers.

**Server — the stamp** (`_stamp_entry_id`, `claude/session_history.py`):

| Direction | Observation |
| --- | --- |
| ON | streamed body names its entries; `test_the_stream_names_the_entry_each_frame_came_from` passes |
| OFF (`if False and entry_id:`) | `AssertionError … named=[]` — no id anywhere on the wire |

**Client — the fallback** (`lastHeldTranscriptEntryId`):

| Direction | Observation |
| --- | --- |
| ON | second open states `3333…` (the delivered entry) |
| OFF (`entry?.['id']` only) | second open states `1111…` (the history entry) — the frozen position |

**Server — the open gate** (`observe_turn`), raised in review on PR #354 and
then measured, turn already finished at open, `after_entry_id=<history tail>`:

| Direction | Observation |
| --- | --- |
| ON (`busy_at_open or backlog > 0`) | the unseen head is handed over: `DRAINED-PROMPT` / `HEAD-OUTPUT` / `TAIL-OUTPUT` all delivered, stream closes |
| OFF (`is_turn_busy` alone) | `BUSY_AT_OPEN: False`, `BODY_LEN: 0` — the stated position is computed and thrown away; the pane stays empty until a manual refresh |
| `live` return removed | the backlog is delivered and the stream then polls forever — `asyncio.exceptions.TimeoutError` at the drain budget |

Captured from the real action before any theorising, `after_entry_id=<history tail>`:

```
<flow-user-message i="0" … role="user">DRAINED-PROMPT</flow-user-message>
<flow-chat i="1" … role="assistant">HEAD-OUTPUT…
contains 'process_entry': False
contains 'transcript-entry-id': False
on-disk entry ids present in body: []
```

And client-side, two consecutive opens over that same real wire:

```
after_entry_id sent per open: ["HIST-ENTRY-9","HIST-ENTRY-9"]
items: ["earlier answer","DRAINED-PROMPT","HEAD-OUTPUT","DRAINED-PROMPT","HEAD-OUTPUT"]
```

This settles the "adjacent suspicion" left open in
[surface_transcript_reconcile.md](surface_transcript_reconcile.md) — the
watermark premise really is false, and now it has a lever.

## Invariants

* **Anything a client must read off a LIVE frame belongs in `attributes`.**
  `process_entry` is history-only by construction. Putting a new field on the
  typed payload and consuming it in a live path reproduces this class of bug
  exactly, and it fails silently: the field is simply absent, never an error.

* **`entry_to_flowdata` serves every vendor on the observe-turn path.** It is
  imported unconditionally inside `observe_turn`, so a change there is not a
  claude-only change. Conversely, a fix applied only to a vendor's own converter
  does not reach observe-turn.

* **Resolve a transcript id two-tier, always** — `processEntry.transcript_entry.id`
  *then* `attributes['transcript-entry-id']`. `historyIdentityKey` and
  `lastHeldTranscriptEntryId` must not disagree; a third copy of this expression
  lives at `ui/src/components/floating-chat/groupTurnEvents.ts:264`.

* **Never gate the whole stream on liveness once the client has stated a
  position.** `is_turn_busy` answers "is there more coming", not "has the client
  seen what is already there". Those are different questions, and a short turn
  separates them every time: the client asks after the turn ended, and the only
  copy of what it missed is on disk. Serve the backlog, THEN decide whether to
  follow.

* **A backlog-only stream must close itself.** The turn-end signals — the
  provider marker plus `is_turn_busy` — are for a stream that watched the turn
  happen. Neither can end a stream that opened afterwards (the marker is already
  past; `saw_marker` therefore stays false and the PTY branch never returns).

* **A position that cannot advance is worse than no position.** Watermark-at-open
  loses the head of one turn; a frozen `after_entry_id` re-delivers every turn
  since the last history load, on every open, forever.

## Failure modes

* **Everything renders twice.** The dominant symptom. `_findDuplicateOpenGroup`
  (`ts_sdk/src/flow_processing/flow-data-stream.ts:390`) does not save you: it
  scans **still-open groups only**, and the earlier stream's groups closed when
  that stream closed.

* **User prompts double even when nothing is offset.** `user-message` is not in
  `STREAMABLE_ELEMENT_TYPES` (`flow-element-types.ts:131` — reasoning, chat,
  shell-output, trace, cached-message), so it takes the non-streamable branch and
  is pushed with **no dedup at all**.

* **Known limit, not a bug to re-open.** `is_same_flow_data_streaming`
  (`flow_sdk/core/flow/streaming/response_handler.py:409`) merges CONSECUTIVE
  same-element-type entries into one element, and a start tag's attributes are
  fixed when it opens — so a run of several assistant entries is named by its
  **first**. Alternating user/assistant turns give every entry its own element.
  Closing the gap needs a per-entry `group_id` (the shape
  `code_agentic_worker.py:351` already mints per content block), which splits
  merged bubbles into one per entry — a visible rendering change, deliberately
  out of scope.

* **The whole turn is invisible until a manual refresh.** The short-turn
  variant of this ticket's bug, and the one the duplicate-render symptom hides:
  when the stream closes empty there is nothing to render twice, so it reads as
  "the chat just did not update". Distinguish them by `busy` at open — duplicates
  mean the stream ran with a frozen position, silence means it never ran.

* **Not proven — adjacent suspicion.** `useObservedTurn`'s re-entry guard
  (`ui/src/components/entity-execution-panel/hooks/useObservedTurn.ts:36`) is a
  `useRef`, i.e. **per hook instance**, and two components call the hook
  (`EntityExecutionPanel.tsx:433`, `SimpleChatPane.tsx:48`). N mounted hooks open
  N streams into the one shared `flowDataStream` — verified at unit level. Whether
  two are ever mounted for the same process in practice was **never observed**: a
  probe counting concurrent observations was installed and never recorded a peak
  above 1. Treat parallel streams as an untested hypothesis, not a rule.
