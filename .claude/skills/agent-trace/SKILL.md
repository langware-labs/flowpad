---
id: ca5d82f9-b6ba-57e6-8438-a8129197ddf7
name: agent-trace
description: Analyze an agentic execution from its session transcript and produce
  an AgentTrace record — goals, subgoals, divergences, issues, stucks, skill loads/fails
  on a multi-lane timeline. Input is a session id; output is a saved AgentTrace entity
  viewable in the timeline visualizer.
tags:
- analysis
- transcript
- review
allowed-tools: Read, Write, Bash, Grep, Glob
output-dir: .flow/skills/agent-trace/_results
instructions-file: .flow/skills/agent-trace/instructions.md
---

# Agent Trace Analyzer

## Overview

You analyze one agentic execution (a worker session transcript) and produce an **AgentTrace** record: the precomputed answer to "what happened, did it go well" for a complex agentic process. The deterministic skeleton (lanes, segments, timings, costs, tool failures, stuck loops, skill loads) is built by a Python synthesizer — **never compute timings or counts yourself**. Your job is the judgment layer: goals, subgoals, divergences, skill-performance verdicts, and the overall verdict.

**Input**: a session id (UUID), optionally a worker type (`claude` | `codex` | `copilot`, default `claude`).
**Output**: an AgentTrace entity saved via the backend API, with the full trace JSON at its `asset_ref`.

Read `instructions-file` for accumulated learnings before starting; append new learnings when you hit something non-obvious.

## Environment

**Never hardcode port numbers, and never expect the caller to hand you a URL.** As a spawned worker you inherit `FLOW_INSTANCE` — resolve the backend that spawned you from its `server.json`:

```bash
API_URL="http://localhost:$(jq -r .port ~/.flow/instances/${FLOW_INSTANCE:-prod}/server.json)"
OUT="${OUT:-/tmp/agent-trace}"   # .flow/skills/agent-trace/_results when run inside the flowpad repo
```

If `server.json` is missing, that instance's backend isn't running — stop and report, don't guess ports.

## Procedure

### 1. Synthesize the skeleton

```bash
mkdir -p "$OUT"
curl -sf "$API_URL/api/v1/workers/claude/<SESSION_ID>/trace-skeleton" \
  | jq '.skeleton' > "$OUT/<SESSION_ID>.skeleton.json"
jq '.summary' "$OUT/<SESSION_ID>.skeleton.json"
```

The backend runs the deterministic synthesizer server-side — works from any workdir, no repo venv needed. `source_path` inside the skeleton is the root transcript JSONL; subagent transcripts live at `<dir>/<session_id>/subagents/agent-*.jsonl`.

Large team sessions produce skeletons of several MB — do NOT read the whole file. Use `jq` to pull what you need:

```bash
J="$OUT/<SESSION_ID>.skeleton.json"
jq '.summary' $J
jq '[.lanes[] | {id, agent_type, description, segments: (.segments|length)}]' $J
jq '[.markers[] | select(.severity=="attention")]' $J
jq '[.events[] | select(.kind=="skill_load" or .kind=="skill_fail" or .kind=="interrupt")]' $J
jq '[.lanes[].segments[] | select(.severity=="attention") | {id, label, start_ts, end_ts}]' $J
```

### 2. Investigate

For each attention segment / marker cluster, read the relevant transcript span to understand what actually happened (use the root JSONL for `root` lane, the matching `subagents/agent-<id>.jsonl` for subagent lanes). Look for:

- **Goals / subgoals** — what was the agent trying to achieve, per segment span? Root lane goals usually come from user prompts (already segment labels); subgoals from todo updates and assistant statements.
- **Divergences** — goal drift, wrong-tool loops, work on something the user didn't ask for, abandoning a goal silently.
- **Issues beyond the deterministic ones** — wrong conclusions, false claims of success, masked failures, retried flakiness.
- **Stucks** — the synthesizer marks ≥3 identical failing commands; add judgment-level stucks (spinning across *different* commands on one problem, long unproductive spans).
- **Skill performance** — for every `skill_load` event, judge the span that follows: did the skill's instructions get followed? Where did they mislead or under-specify? This feedback is the product — be precise about which instruction needs adjusting.

### 3. Annotate

Write `$OUT/<SESSION_ID>.annotations.json`:

```json
{
  "verdict": "ok | mixed | bad",
  "verdict_reason": "one line",
  "goals": [{"label": "...", "lane_id": "root", "start_ts": "...", "end_ts": "...",
             "verdict": "ok|mixed|bad", "subgoals": [{"label": "...", "start_ts": "...", "end_ts": "..."}]}],
  "divergences": [{"ts": "...", "lane_id": "...", "label": "...", "detail": "...", "severity": "notable|attention"}],
  "issues": [{"ts": "...", "lane_id": "...", "label": "...", "detail": "...", "severity": "attention"}],
  "notes": ["skill <name>: instruction X caused Y — suggest Z"]
}
```

Timestamps must be copied verbatim from skeleton entries (ISO-8601 Z) so markers land on the timeline.

### 4. Create the record

One call: the server re-synthesizes the skeleton, merges your annotations, and creates a **new** AgentTrace record (analyses are history — reruns add entries, never overwrite):

```bash
jq -n --slurpfile a "$OUT/<SESSION_ID>.annotations.json" '{annotations: $a[0]}' \
  | curl -sf -X POST "$API_URL/api/v1/workers/claude/<SESSION_ID>/agent-trace" \
      -H 'Content-Type: application/json' -d @-
```

Response: `{ok, id, asset_ref, summary}`.

### 5. Verify

- The POST response carries the entity `id` and `asset_ref`; `test -f` the asset_ref and `jq .summary` it.
- `curl -sf "$API_URL/api/v1/graph/agent_trace/<id>"` returns the summary fields (verdict, counts) — `trace` itself must NOT be in the GET response (blob).
- Report to the user: verdict + reason, issue/divergence counts, the viewer URL `/dock/assets/editor/agent_trace/typeid/agent_trace-<id>`, and your skill-performance notes.
