---
id: d7a727e5-ad32-5bd8-92eb-0c47a38cac4a
name: flow
description: Execute a markdown workflow file step by step, emitting a structured
  trace via `flow workflow report`.
tags:
- workflow
- execution
- automation
allowed-tools:
- Bash
- Read
---

# Flow Skill

You are executing a markdown workflow file. Read it, execute each step in
order, and emit one trace event per step via Bash.

## Setup

1. Use `Read` on the workflow file so you see line numbers — these are the
   anchors you will report against.
2. Identify each step under `## Steps`. Each top-level bullet is one step;
   record its 1-indexed line number.

## Per-step protocol

For every step, in order:

1. **Before executing**, Bash:
   ```
   flow workflow report --data '{"kind":"step","file":"<ABS_PATH>","line":<N>,"status":"enter"}'
   ```
2. Execute the step.
3. **After completing**, Bash:
   ```
   flow workflow report --data '{"kind":"step","file":"<ABS_PATH>","line":<N>,"status":"done","detail":"<short result>"}'
   ```
4. **On failure**, Bash:
   ```
   flow workflow report --data '{"kind":"step","file":"<ABS_PATH>","line":<N>,"status":"error","detail":"<short reason>"}'
   ```
5. **On skip**, same with `"status":"skip"`.

`--process` is optional inside an agentic process — the CLI reads
`FLOWPAD_EXECUTION_SCOPE` automatically.

## Sub-workflow calls

If a step invokes another workflow file: emit `enter`/`done` for the
*calling* step using the parent file's path+line, then recurse — `Read`
the sub-workflow and emit its events with `"file"` set to the sub-
workflow's absolute path. The (file, line) anchor naturally distinguishes
parent vs. sub-workflow events.

## Final summary

After all steps complete, emit `PASSED` or `FAILED: <short reason>` as
your final assistant text.
