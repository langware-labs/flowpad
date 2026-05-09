---
name: session_analysis
description: Analyze agentic session transcripts to surface automation opportunities, preventable errors, and behavior corrections.
tags:
  - analysis
  - transcript
  - quality
allowed-tools: [Read, Write]
---

# Session Analysis Skill

You are reviewing an agentic transcript for quality and improvement opportunities.

## Objectives

1. **Automation Opportunities**
   - Identify repeatable tasks or patterns that could be automated.
   - Recommend concrete automation ideas (scripts, tools, workflows).

2. **Preventable Errors**
   - Find errors or missteps that could be prevented.
   - Describe the likely cause and how to prevent recurrence.

3. **Behavior Corrections**
   - Flag unwanted behaviors (e.g., excessive retries, redundant steps).
   - Suggest corrections or guardrails.

## Output

Produce a concise, structured report in markdown with:
- Summary
- Automation Opportunities
- Preventable Errors
- Behavior Corrections

Write the report to `analysis.md` in the current working directory.

---

## Workflow Mode (conditional)

If your invocation prompt provides `WORKFLOW_TRACE_PATH`, switch to this
mode *instead* of writing `analysis.md`. The prompt will also provide:

- `WORKFLOW_TRACE_PATH` — absolute path to `workflow.trace.jsonl`. Each
  line is a `WorkflowReportEntry`: `{ts, kind, file, line, status, detail?, label?, target?}`.
- `TRANSCRIPT_PATH` — absolute path to the runner's session jsonl
  (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`).
- `OUTPUT_PATH` — absolute path where you must write `workflow.analysis.jsonl`.

### Protocol

1. `Read` both inputs.
2. Group trace events by `(file, line)`. Pair each `enter` with the next
   `done` / `error` / `skip` for the same anchor. Unpaired `enter` events
   are tagged as `incomplete` and become an issue.
3. For each pair, find the transcript span between `enter_ts` and `done_ts`
   (use `ts` from each trace entry as the inclusive bracket). Collect
   tool calls in that span — especially `mcp__debugMcp__browser_*`,
   `mcp__claude-in-chrome__*`, `Bash`, and `ToolSearch` — plus any
   assistant errors.
4. For each anchor, compose one analysis record per the schema below.
   Sort records by `anchor.line` ascending.
5. `Write` the records to `OUTPUT_PATH` — one JSON object per line
   (JSONL). Do not write any prose markdown in this mode.

### Analysis record schema

```json
{
  "anchor": {"file": "/abs/path/workflow.md", "line": 12},
  "step_text": "<the line's text from the workflow file, trimmed>",
  "trace": {
    "enter_ts": "2026-05-08T21:09:21.123Z",
    "done_ts":  "2026-05-08T21:09:35.456Z",
    "duration_ms": 14333,
    "status": "done",
    "detail": "<from trace, may be null>"
  },
  "transcript_span": {
    "start_uuid": "<first transcript uuid in the span>",
    "end_uuid":   "<last transcript uuid in the span>",
    "tool_calls": [
      {"name": "mcp__debugMcp__browser_navigate", "result_summary": "<short>"}
    ]
  },
  "issues": [
    {"kind": "wrong_tool", "detail": "<why>"}
  ],
  "recommendation": "<one-line concrete improvement, or null>"
}
```

### Issue kinds to surface

- `incomplete` — `enter` with no matching terminal status.
- `wrong_tool` — fragile tool used (e.g. `browser_snapshot(target=css)` for
  presence checks; prefer `browser_evaluate(document.querySelector)`).
- `retry` — multiple navigates / clicks for one logical action.
- `mid_run_toolsearch` — `ToolSearch` invoked after the run started.
- `protocol_violation` — anchored event has no transcript span.

If the step ran cleanly with no concerns, `issues` is `[]` and
`recommendation` is `null`.

### Final message

After writing the file, output exactly one line as your final assistant
text:

```
ANALYSIS WRITTEN: <count>
```

so the harness can confirm. Do not write a prose summary in this mode —
the JSONL file is the deliverable.
