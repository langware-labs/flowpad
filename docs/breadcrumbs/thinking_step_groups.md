---
id: 35c763c4-1354-483c-8be9-746a57d30d42
title: One Thinking block per step
tags:
- breadcrumb.test.thinking_step_groups.rules
description: A chat Thinking block holds one step's reasoning — a tool row seals it,
  a new thought seals the tool run — and splitLiveGroup merges every dense group since
  the last message so the footer chip still counts the whole turn.
---
# One Thinking block per step

> Ground truth. Proven by RCA on 2026-11-10 (FLOWPAD-2350). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.thinking_step_groups.rules
sites:
  - rel_path: "ui/tests/unit/thinking-block-per-step.test.tsx"
    line: 65
    note: "FAILING? read this tag's rules before editing groupTurnEvents.ts - a tool row must seal the thinking before it, and splitLiveGroup must merge every dense group since the last message"
```

## Expected behavior

In vibe and Standard chat, a turn where the agent thinks, runs a tool, thinks
again, runs another tool… without writing text in between shows **one
collapsible "Thinking" block per step**, in order: thought → action → thought.
A block never collects thinking from more than one step, and it does not keep
growing for the whole turn.

While the turn is live in vibe mode, the footer chip (`TurnEventChip`) still
counts **every** tool call since the last chat message, not only the current
step's.

## Internals

The frames are correct when they reach the UI. The grouper is the only place
that decides where a step ends.

| Layer | Where | What it does here |
| --- | --- | --- |
| Transcript → frames | `entry_to_flowdata`, `flow_sdk/builtin/agentic_process/cli_drivers/claude/session_history.py:130` | One assistant entry with a `thinking` block yields REASONING, then its CHAT (`:197`); a `tool_use` yields TOOL_CALL. The live PTY tail and the history reload both use it. |
| Frame stream | `FlowDataStream.ingestBatch` / `ingest`, `ts_sdk/src/flow_processing/flow-data-stream.ts:198` / `:247` | Keeps REASONING and TOOL_CALL separate. Measured on the report's frames: 10 in, 10 out. |
| **Grouping** | `createTurnGrouper` → `consume`, `ui/src/components/floating-chat/groupTurnEvents.ts:124` / `:202` | Two open runs: `thinkingTail` (REASONING) and `tail` (tool/status/error). `flushThinkingTail` (`:196`) seals the first into a `thinking` group, `flushTail` (`:187`) seals the second into a `dense` group. |
| Step boundary: thought | REASONING branch, `groupTurnEvents.ts:226` | `flushTail()` before `thinkingTail.push` — a new thought seals the tool run before it. |
| Step boundary: action | DENSE branch, `groupTurnEvents.ts:264` | `flushThinkingTail()` before `tail.push` — a tool row seals the thinking before it. |
| Open runs at the end | `next()`, `groupTurnEvents.ts:281` | At most one run is open, so the trailing group order cannot be wrong. |
| Live split | `splitLiveGroup`, `groupTurnEvents.ts:83` | While active, walks back over the trailing `dense`/`thinking` groups after the last message, merges all the `dense` ones into `liveEvents`, and leaves the `thinking` ones inline. |
| Render | `TurnGroupsList`, `ui/src/components/entity-execution-panel/TurnGroupsList.tsx:239` → `ThinkingSummary` | One disclosure per `thinking` group. |
| Vibe footer chip | `EntityExecutionPanel.tsx:531` (`splitLiveGroup(turnGroups, dense && activity.active)`) → `TurnEventChip` at `:1001` | Reads `liveEvents`. |

Frames the grouper drops before the DENSE seal — `NON_ACTIVITY_SUBTYPES`
(`token_usage`, `meta`, `summary`) and a `Skill` tool pair — do not end a step.
They render nothing, so sealing on them would split one step's thinking into
two blocks with nothing between them. A skill's step still ends: its meta
message follows and is a MESSAGE.

## Invariants

1. **A `thinking` group is one step's run of REASONING frames.** It is sealed
   by a message, a worker-unavailable or launch-failure row, **or a dense row**.
   Sealing only on a message is the FLOWPAD-2350 bug.
2. **A REASONING frame after a dense row seals that dense run first**, so the
   groups alternate thinking / dense in the order they happened.
3. **Live and reload must agree.** Ingesting frames one at a time
   (`stream.ingest` + incremental `useTurnGroups`) and in one batch
   (`ingestBatch`) give the same blocks. The test checks both paths.
4. **While a turn is live, the footer chip gets every dense group since the
   last message, merged.** Per-step sealing turns one dense group into one per
   step, so taking only the last group drops the earlier steps' tool calls.
   `planTurnFiles` (`ui/src/components/floating-chat/turnFiles.ts:198`) already
   handles several dense groups in one turn.
5. **`thinking` groups are never pulled into the chip.** They stay inline, one
   per step.

## Failure modes

| Symptom | Cause | Invariant |
| --- | --- | --- |
| One Thinking block holds paragraphs from several steps and grows for the whole turn (vibe and Standard) | `consume` flushed `thinkingTail` only on a MESSAGE; a TOOL_CALL went into `tail` without sealing it, so a think → tool → think turn became one `thinking` group ahead of one `dense` group. Proven both ways on the report's frames: seal on → one block per step; seal reverted → `thinking events=3`. | 1, 2 |
| Mid-turn, the vibe footer chip is empty while the agent thinks, then counts only the current step | Per-step sealing with the old `splitLiveGroup`, which split off only the LAST group, and only when it was dense. Proven: the test's mid-turn case fails with the old function and passes with the merge. | 4 |

## Notes for whoever lands here next

* **Check what is in the block before blaming the content.** FLOWPAD-2350 was
  first reported as "non-thinking summaries" leaking into the block. The
  transcript showed every paragraph was a real `thinking` block, signed, from a
  different API message (lines 1682/1683, 1687, 1691 of the session). The
  content was right; the step boundaries were wrong.
* The test needs no agent. Its fixture,
  `ui/tests/unit/fixtures/claude-multi-step-thinking-frames.json`, is the real
  frames from that transcript run through `entry_to_flowdata`, with tool inputs
  shortened and the user path replaced. It enters the way the chat panes do:
  `FlowDataStream` → `useTurnGroups` → `TurnGroupsList`, with "show tool calls"
  off.
