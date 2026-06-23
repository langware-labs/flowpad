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

**Per-asset attribution (the product's structured form).** When a divergence or issue is caused by a *skill's* instructions — not the environment, not the user — attribute it to that skill so the fix half (skillit) can consume it per-asset. On that finding set:

- `skill` — the **name** of the loaded skill it implicates (from the `skill_load` event / the owning skill lane's `skill_name`). This is the routing key: skillit resolves a target skill by name.
- `section_hint` — *where in that skill's files the fix belongs* — quote a **verbatim substring** of the skill text (a heading or instruction line), not a paraphrase with `...` ellipses. The backend resolves your quotes against the skill folder; a quote that exists nowhere is flagged `unresolved_anchors` (a stale anchor), so keep it literal and current.
- `evidence` — `{"quote": "<verbatim transcript excerpt>", "ts": "<ISO-8601 Z>"}` proving the finding from the run itself. **A finding with no run evidence is a guess, not a finding** — the same bar review mode applies to its context citations. This quote is what the verify step (below) and skillit check against.

A finding with no `skill` is **session-level** (goal drift, a wrong conclusion, a flaky retry that no skill caused) — leave `skill` unset; it stays for the human, never goes to a fixer. Prefer one structured attributed finding over a prose `notes` line: `notes` is for context that isn't a per-skill defect; anything actionable on a skill belongs in a `divergence`/`issue` with `skill` + `section_hint` + `evidence` set.

### 3. Annotate

Write `$OUT/<SESSION_ID>.annotations.json`:

```json
{
  "verdict": "ok | mixed | bad",
  "verdict_reason": "one line",
  "goals": [{"label": "...", "lane_id": "root", "start_ts": "...", "end_ts": "...",
             "verdict": "ok|mixed|bad", "subgoals": [{"label": "...", "start_ts": "...", "end_ts": "..."}]}],
  "divergences": [{"ts": "...", "lane_id": "...", "label": "...", "detail": "...", "severity": "notable|attention",
                   "skill": "<skill-name, if a skill caused it>", "section_hint": "<verbatim skill quote>",
                   "evidence": {"quote": "<verbatim transcript excerpt>", "ts": "..."}}],
  "issues": [{"ts": "...", "lane_id": "...", "label": "...", "detail": "...", "severity": "attention",
              "skill": "<skill-name, if applicable>", "section_hint": "<verbatim skill quote>",
              "evidence": {"quote": "<verbatim transcript excerpt>", "ts": "..."}}],
  "notes": ["context that is NOT a per-skill defect (env, one-off) — skill defects go in divergences/issues with skill+section_hint+evidence"]
}
```

`skill` / `section_hint` / `evidence` are optional per finding — set them when a skill caused it (see Per-asset attribution above), omit for session-level findings. The backend folds attributed findings into `annotations.by_skill[<skill>]` (the per-asset bucket skillit consumes) and the rest into `annotations.unattributed`, and stamps each with `judged_against` (`loaded` = the SKILL body the run actually used, recovered from the transcript; else `disk`) and `unresolved_anchors`. **Judge against the loaded body, not on-disk** — if `summary.skill_drift[<skill>]` is true the run used a different skill version than what's on disk now, so a finding about on-disk text the run never saw is likely spurious.

Timestamps must be copied verbatim from skeleton entries (ISO-8601 Z) so markers land on the timeline.

### 3.5 Verify findings (adversarial, independent)

Your findings are hypotheses until the transcript backs them. Before you create the record, **substantiate each attributed finding with an independent refuter** — a fresh look biased toward disproving it — so a misread trace never reaches skillit as a fix. (This run's own analysis can't be its own judge: it already believed the finding.)

For each finding in `annotations.by_skill[*].findings`, launch ONE `model: haiku` agent from `agents/finding-verifier.md`, filled with the finding, its `evidence` quote, the session id, and the loaded skill body (`agent_trace --loaded-skills <SESSION_ID>` — the body the run actually used). It returns `{substantiated, quote, reason}`:

- **substantiated** → keep the finding.
- **refuted** → move it out of `divergences`/`issues` into a top-level `refuted` list in your annotations (label, skill, reason) — flag it, never silently drop. It does not go to skillit; it goes back as signal that the finding was wrong.

Run verifiers concurrently (they're independent). A finding whose `evidence` is empty, or whose `judged_against` is `disk` while `summary.skill_drift[<skill>]` is true (graded against text the run never saw), should be treated as refuted unless the refuter still substantiates it from the transcript.

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
