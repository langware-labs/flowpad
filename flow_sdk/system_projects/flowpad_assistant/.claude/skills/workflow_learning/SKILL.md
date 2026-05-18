---
id: 6317c0da-0839-551e-a9b0-b4fefb885c66
name: workflow_learning
description: Synthesize across a workflow's recent runs. Update memory.md with concrete
  learnings the next runner can apply, log the attempt, and surrender to the user
  via feedback.md only when stuck after multiple tries.
tags:
- workflow
- learning
- memory
allowed-tools:
- Read
- Write
---

# Workflow Learning Skill

You are improving a workflow's persistent memory based on the latest run.

## Inputs (resolved from your invocation prompt)

- `WORKFLOW_PATH`         — absolute path to the workflow `.md` file.
- `LATEST_TRACE_PATH`     — absolute path to the just-archived `workflow.trace.jsonl`.
- `LATEST_ANALYSIS_PATH`  — absolute path to the just-archived `workflow.analysis.jsonl`.
- `CURRENT_MEMORY_PATH`   — absolute path to `memory.md`. May not exist yet on the first run.
- `LEARNING_LOG_PATH`     — absolute path to `learning.log.md`. May not exist yet.
- `FEEDBACK_PATH`         — absolute path to `feedback.md`. May already exist from a prior surrender.
- `ATTEMPT_COUNTER_HINT`  — integer N: how many learning iterations have run before this one (1 on the first iteration).

## Outputs

You will write up to three files:

### 1. `memory.md` — always

Free-form markdown. Aim for these sections (omit a section if you have nothing for it):

```markdown
# Workflow memory

## Tools to prefer / avoid
- Concrete tool recommendations the next runner should follow.

## Common pitfalls
- Observed traps and how to avoid them.

## Workflow-specific quirks
- Anything specific to this workflow's UI / surface.
```

Hard cap: **~3 KB**. If your rewrite would exceed that, compact aggressively before writing.

### 2. `learning.log.md` — always

Prepend ONE new entry at the top in this exact format:

```markdown
## <ISO timestamp, UTC, e.g. 2026-05-09T01:23:45Z>
- Issue: <one line — the dominant issue kind from the latest analysis>
- Fix: <one line — what you changed in memory.md>
- Attempt: #N
```

Then keep only the most recent **20 entries** total. Drop older ones from the file.

### 3. `feedback.md` — only when surrendering

Surrender means: the workflow needs a human change before learning can help further.

Write `feedback.md` iff one of these holds:

- The same issue kind appears in **3+ recent learning.log entries** with no resolution.
- The latest trace has a `status: "error"` event that the analysis cannot tie to a tool /
  approach fix (test premise itself is wrong, a selector has been removed from the UI, an
  assertion contradicts observed behavior).

`feedback.md` is **not a log** — overwrite each time you surrender. **If you do NOT surrender on this run, leave `feedback.md` alone** (do not delete or overwrite it).

Format: an actionable change-request, e.g.:

> Selector `[data-testid="opener-plus-button"]` returns no element — the UI may have renamed or removed it. Update the workflow's step to use `<new selector>`.

> Step 6 expects scrollback to survive `clear`; the terminal-app implementation always clears scrollback. Either change the workflow's expectation or fix the terminal.

## Protocol

1. `Read` all input files that exist. Files that don't yet exist are valid (first run).
2. Inspect the latest analysis: any `status: "error"`? any new `issues[]` kinds?
3. Inspect `learning.log.md`: is the dominant issue kind already logged 3+ times without
   resolution?
   - **If yes** → surrender path: `Write` `feedback.md`, add a `surrendered` log entry, still
     rewrite `memory.md` in case the next operator (human) updates the workflow.
   - **If no** → improvement path: rewrite `memory.md` with at least one new concrete
     actionable lesson tied to the latest analysis findings.
4. Always prepend a `learning.log.md` entry. Always rewrite `memory.md`.
5. After writing, output exactly ONE final assistant line:
   ```
   LEARNING WRITTEN: memory <bytes>, log <count> entries[, feedback]
   ```
   The `feedback` token is included iff you wrote `feedback.md` on this run.

## Notes

- **Do not read the runner's full transcript** — it may be hundreds of KB. The trace + analysis
  files contain everything you need. If you find yourself wanting more context, write a memory
  entry about it instead of fetching more data.
- **Memory is for the agent, not for you.** Write it as imperative guidance the next runner
  will follow ("Use `browser_evaluate` for presence checks; `browser_snapshot(target=…)` is
  unreliable"), not as a narrative recap of the run.
- **Surrender is not a failure** — it's a useful signal that the workflow itself needs a human
  edit. Once surrendered, the next iteration still reads the fresh memory and may un-surrender
  if conditions change (e.g. selector restored).
