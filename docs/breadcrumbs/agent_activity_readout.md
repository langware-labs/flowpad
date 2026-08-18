---
title: Agent activity readout rules
tags:
- breadcrumb.test.agent_activity_readout.rules
description: The chat activity line may only report the CURRENT turn's newest operation,
  must hold each one 500ms, and must let an operation refine itself — every rule here
  is a shipped bug.
version: 2
---

# Agent activity readout rules

> Ground truth. Proven on 2026-08-13 (FLOWPAD-1980). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.agent_activity_readout.rules
sites:
  - rel_path: "ui/tests/unit/chat-activity-readout.test.tsx"
    line: 49
    note: "FAILING? read this tag's rules before editing — each case is a shipped bug, not a preference"
  - rel_path: "ui/tests/unit/chat-activity-readout.test.tsx"
    line: 131
    note: "FAILING? read this tag's rules before editing — the 500ms floor and refinement pass-through are proven, not tunable"
```

## Expected behavior

While a turn is in flight, the chat activity line names what the agent is doing
right now — `Editing · foo.ts`, `Reading · hello.txt`, `Running command…` — and
falls back to the coarse worker phase (`Thinking`, `Working`) when no operation
is the current story. It renders nothing when idle.

Every rule below exists because its absence shipped a visible defect. None is a
style preference, and several look wrong until you know which obvious
alternative failed.

## Internals

**Where the data comes from.** The backend consolidated this in the
`transcript_entry` work: every operation frame carries a typed
`process_entry.transcript_entry` with `path` / `command` / `query` on it —
**live as well as on replay**. There is no separate live-vs-history shape to
handle, and no need to sniff tool names or regex payloads.

| Layer                                                              | Where                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Entry kinds (`file_edit`, `shell_command`, `search`, …)            | `flow_sdk/transcript_analyzer/entry.py:17`                                                                     |
| Observation wrapper (`live` / `replay` / `hook_pre` / `hook_post`) | `flow_sdk/transcript_analyzer/process_entry.py:34`                                                             |
| Live stamping, per worker                                          | `flow_sdk/builtin/agentic_process/cli_drivers/{claude,codex,copilot}/event_to_flowdata.py`                     |
| Frontend parse                                                     | `ts_sdk/src/flow_processing/flow-data.ts:636` → `ui/src/components/floating-chat/transcriptEntry.ts:4`         |
| Kind → icon/label/detail                                           | `describeEvent`, `ui/src/components/floating-chat/toolEventDescriptor.ts:66`                                   |
| **What to say**                                                    | `describeCurrentActivity`, `currentTurnSlice` — `ui/src/components/entity-execution-panel/current-activity.ts` |
| **How long to say it**                                             | `useStickyActivity` — `ui/src/components/entity-execution-panel/hooks/useStickyActivity.ts`                    |
| Render                                                             | `ChatActivityLine` — `ui/src/components/entity-execution-panel/ChatActivityLine.tsx`                           |
| Turn's live frames                                                 | `splitLiveGroup`, `ui/src/components/floating-chat/groupTurnEvents.ts:68`                                      |

**Two consumers, deliberately different.** `EntityExecutionPanel.tsx` (vibe)
pulls the live group out of the inline list and puts it behind `TurnEventChip`,
keeping the chat message-clean. `SimpleChatPane.tsx` (Standard mode) takes only
`liveEvents` from the split and keeps rendering every group inline, tool rows
included — that is what Standard mode is for. Consequence: in Standard mode a
running tool appears twice. That is intended, not a bug.

**One operation is observed more than once.** A PreToolUse hook and the worker's
own live frame are two `ProcessEntry` views of a single `transcript_entry`,
sharing a `tool_use_id`. The earlier view can arrive **before the path is
known**. This is the single most surprising fact in this subsystem and the cause
of the longest-lived bug (see below).

## Invariants

1. **Only the current turn may be read.** `currentTurnSlice` cuts twice: at the
   newest `replay`-observed frame (history boundary) and at `turnStartedAt`
   (turn boundary). Both fail open — a frame with no observation kind or an
   unparseable timestamp is kept.
2. **When nothing qualifies, the slice is EMPTY, never the whole buffer.**
   `findIndex` returns `-1`; treating that as "start from index 0" reports every
   frame of a finished turn as current activity.
3. **The newest tool call wins — not the newest** ***unanswered*** **one.** Pairing a
   call against its `TOOL_RESULT` is the stricter-looking rule and it is wrong
   here: `Edit`/`Read` finish within a render, so the unanswered state may never
   exist. Dropping the pairing check is only safe because of invariant 1 — the
   turn scoping is what stops a finished operation reading as live, so do not
   weaken it thinking the pairing check is the guard.
4. **Thinking supersedes the operation before it — via TWO independent
   signals.** A `REASONING` frame newer than the last tool call, *and* the
   worker reporting `WorkerStatus.THINKING`. Both are needed and neither is
   redundant: the frame only exists when the model emits a thinking block, and
   plenty of turns think without one — then the newest frame stays the finished
   tool call and the line sits on `Reading` for as long as the model
   deliberates. The status moves either way. Do not delete the status check as
   "already covered by the frame check"; that is the bug it was added to fix.
5. **Each shown operation gets ≥** **`MIN_ACTIVITY_MS`** **(500 ms).**
6. **Intermediate operations are skipped, never queued.** A queue puts the line
   progressively further behind the agent — showing a file edited seconds ago
   while it is three tools further on. The event chip keeps the count; the turn
   rows keep the full list.
7. **A refinement of the SAME operation applies immediately**, without resetting
   the floor. Same `key` + changed content is not a new operation.
8. **A held value never outlives its turn.** `useStickyActivity` takes the turn
   start as a reset key and drops the held value at once when it changes.
9. **A shell command's text is never shown.** It is unbounded prose with no
   meaningful short form. `shell_command` gets `Running command…` and no detail;
   its `key` still uses the real command so two commands stay two operations.
10. **A terminal worker status is never rendered while the line is up.**
    `COMPLETE` / `INTERRUPTED` / `INACTIVE` / `IDLE` / `PENDING_USER` mean the
    turn ended, so seeing one here means it is stale.
11. **Layout: the detail is the only flexible item.** Everything else is
    `shrink-0`; the detail carries `flex-1 min-w-0 truncate`.

## Failure modes

Each was observed, and each maps to the invariant that prevents it.

| Symptom                                                                         | Cause                                                                                                                                                                  | Invariant |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `Complete` rendered under a live pulse after resuming                           | the entity's `workerStatus` survives the turn boundary; a resumed session hydrates with the previous turn's final status                                               | 10        |
| Previous turn's operation reported as live forever                              | replayed entries have their tool result **folded in**, so they carry no `TOOL_RESULT` and look permanently unanswered                                                  | 1, 3      |
| Every frame of a finished turn reported as current                              | `findIndex` returned `-1`, collapsed into the "start at 0" branch                                                                                                      | 2         |
| `Editing` shown with **no filename**, until an unrelated operation displaced it | the display latch compared only `key`, so the refinement carrying the path was discarded. Measured: label→detail gap 890 ms or never; after the fix 20–30 ms           | 7         |
| Fast `Edit`/`Read` never visible at all                                         | an in-flight-only rule; they complete in tens of ms                                                                                                                    | 3, 5      |
| `Reading` stuck on screen for a long time                                       | the turn went back to thinking without emitting a thinking block, so no `REASONING` frame arrived and the newest frame stayed the finished tool call                    | 4         |
| Long path pushed the clock and event chip out of the pane                       | no flex-shrink discipline; a flex item defaults to `min-width:auto` and refuses to shrink. A fixed `max-w` does **not** fix this — it only clips earlier on wide panes | 11        |
| An operation present at mount replaced instantly                                | `shownAt` seeded to `0`, so a pane remounting mid-turn recorded no start time                                                                                          | 5         |

## Notes for whoever lands here next

* The strings are lingui-translated; the fallback phase words come from
  `WORKER_STATUS_LABEL` (`ts_sdk/src/process/status-labels.ts`), which is a
  plain untranslated record. A mixed-language line is that, not a bug in this
  code. See FLOWPAD-1985.

* Verification that is actually trustworthy here is a `MutationObserver` over a
  live turn, not a poller. A 120 ms sampler steps straight over these
  transitions and will tell you an operation "never renders" when it does.

<!-- flowpad:capsule identity
version: 1
data:
  id: 9445799d-e807-4cdf-80a5-3bfab86b335f
flowpad:endcapsule identity -->
