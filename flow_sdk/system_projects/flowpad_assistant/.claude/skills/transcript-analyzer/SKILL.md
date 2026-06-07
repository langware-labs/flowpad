---
id: 53b95d46-2105-5827-9475-4ddf73060d57
name: transcript-analyzer
description: Analyze Claude Code / agentic session transcripts. Use this whenever
  the user asks to analyze, review, audit, or classify a session or transcript, find
  mistakes / inefficiencies / automation opportunities in a past session, or create
  a skill that prevents an observed failure from recurring — even if they just say
  "what went wrong in that session" or point at a .jsonl transcript file. Replaces
  the former analyze / classify / fix-it / session-analyzer sub-agents.
tags:
- analysis
- transcript
- quality
allowed-tools:
- Read
- Write
- Grep
- Glob
---

# Transcript Analyzer

Review Claude Code session transcripts for quality, classification, and
improvement opportunities. One skill, four modes — pick the mode from what the
user asked for, produce the exact artifacts that mode defines, nothing else.

## Input

The transcript to review may arrive as any of:

- A file path to a JSONL transcript (e.g. `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`)
- Raw transcript content pasted inline
- A plain-text description of what happened in the session

For JSONL files: each line is an event (`user` / `assistant` / tool results).
Read the whole file before judging — early context often explains late
"mistakes".

## Mode selection

| User intent | Mode |
|---|---|
| "classify this session", "what kind of session was this", title/category/command needed | **classify** |
| "analyze", "find issues/mistakes/inefficiencies", "what went wrong" | **analyze** |
| "create a skill to prevent this", "make sure this never happens again", "fix-it" | **fix-it** |
| "review", "report", "automation opportunities", no structured output implied | **report** |

When several apply, prefer the most specific artifact the user asked for.
Default to **analyze** when genuinely unclear.

---

## Mode: classify

Write `classification.json` in the current working directory (or the output
directory the user names) with EXACTLY these four top-level keys — no nesting,
no extra keys, no alternative names:

```json
{
  "category": "<one of: code | debug | explain | design | other>",
  "title": "<short human-readable title, max 60 chars>",
  "command": "<the slash command that best represents this session, e.g. /code>",
  "confidence": <float 0.0-1.0>
}
```

Downstream parsers consume this file mechanically, which is why the shape is
rigid:

- `category` MUST be a **top-level** key. Do NOT wrap the result in a
  `classification`, `result`, `data`, or any other outer key.
- `category` MUST be exactly one of the five literal strings. Do NOT invent
  categories like `script_generation`, `coding`, `programming`.
- Do NOT add fields (`complexity`, `programming_language`, `subtasks`,
  `summary`, …) — they break the consumer.
- Write ONLY valid JSON — no markdown fences, no commentary.

Categories: **code** (writing new code/scripts), **debug** (diagnosing or
fixing bugs/test failures), **explain** (understanding/documenting code or
concepts), **design** (architecture, planning), **other**.

Wrong shapes (do not produce): `{"classification": {...}}`,
`{"classification": "code"}`, `{"category": "script_generation"}`,
`{"category": "code", "complexity": "simple"}`.

Right: `{"category": "code", "title": "Hello World Python script", "command": "/code", "confidence": 0.95}`

## Mode: analyze

Identify mistakes, misunderstandings, inefficiencies, and automation
opportunities. Write BOTH files to the current working directory:

### `analysis.json`

Valid JSON (no markdown fences) with exactly this structure:

```json
{
  "session_id": "<session id if available, else 'unknown'>",
  "issues": [
    {
      "name": "kebab-case-issue-name",
      "title": "Clear concise title of the issue",
      "description": "Clear description of the issue, up to 3 lines",
      "category": "<one of: misunderstanding | mistake | inefficiency | automation_opportunity>",
      "occurrence": "description of where in the transcript this occurred",
      "recommended_scope": "<user | project>"
    }
  ]
}
```

`issues` may be empty if the session had no problems. `recommended_scope` is
`user` if the issue is general behavior, `project` if specific to the
codebase the session ran in.

### `analysis.md`

Human-readable companion report:

- **Summary** — 2-3 sentence overview of what the session accomplished
- **Issues Found** — per issue: title, category, description, recommendation
- **Automation Opportunities** — repeatable patterns that could be scripted

If nothing is wrong, say "No issues detected" rather than inventing filler
findings.

## Mode: fix-it

Everything **analyze** does, PLUS a prevention skill. All three artifacts must
exist before the turn ends — the task is incomplete if any is missing:

1. `analysis.json` — same schema as analyze mode
2. `analysis.md` — same shape as analyze mode, plus a section describing the skill being created
3. `<issue-name>/SKILL.MD` — a folder named after the **single most impactful**
   issue (kebab-case, taken from the issue's `name`), containing:

```markdown
# <Skill Display Name>

## When to use
<Trigger conditions — when should Claude apply this skill>

## Instructions
<Step-by-step instructions for Claude to follow>

## Examples
<Optional: examples of correct behavior>
```

The `SKILL.MD` must be actionable and self-contained — no references to
external files. Create exactly one skill folder, for the issue whose
recurrence would be most costly.

## Mode: report

Free-form quality review when no machine-readable artifact is needed. Write a
concise markdown report to `analysis.md` in the current working directory:

- **Summary** — 2-3 sentence overview of what the session accomplished
- **Automation Opportunities** — repeatable patterns worth scripting, with
  concrete suggestions (scripts, tools, workflows)
- **Preventable Errors** — errors with likely cause and how to prevent recurrence
- **Behavior Corrections** — unwanted behaviors (excessive retries, redundant
  steps) and suggested guardrails

---

## Rules (all modes)

1. Be concise and actionable — no filler text.
2. JSON artifacts contain ONLY valid JSON: no markdown fences, no prose before
   or after. They are parsed by machines, not read by people.
3. Ground every finding in the transcript — cite where it occurred. If you
   can't point to it, don't report it.
4. Honor an explicit output directory if the user names one; otherwise write
   to the current working directory.
