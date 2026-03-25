---
name: compile-workflow
description: Read a source workflow markdown file and generate a concrete, numbered step-by-step prepared version.
tags:
  - workflow
  - preparation
  - compilation
allowed-tools: []
---

# Compile Workflow Skill

You are preparing a workflow file for execution. Your job is to read the source workflow and produce a concrete, numbered step-by-step `.prepared.md` file that Claude can execute directly.

## Instructions

You will be given:
- A **source workflow path** — the original markdown file describing the workflow
- A **prepared output path** — where to write the compiled result

## Steps

1. **Read** the source workflow file at the given source path.

2. **Analyse** the workflow and break it into concrete, independently actionable steps. Each step must:
   - Be numbered (1, 2, 3, …)
   - Start with an imperative verb (e.g. "Create", "Run", "Check", "Write")
   - Be self-contained and executable without referring to other steps
   - Include any file paths, commands, or parameters needed to carry it out
   - Preserve any conditional logic as explicit if/else branches

3. **Write** the prepared file to the given output path using this structure:

```
# <Workflow Title> — Prepared

_Prepared from: <source path>_

## Steps

1. <First concrete step>
2. <Second concrete step>
3. …

## Notes

<Any important caveats, assumptions, or fallback instructions from the source>
```

4. **Confirm** by printing: `Prepared workflow written to <output path>`

## Rules

- Do not skip or merge steps — be explicit and verbose.
- If the source has section headings, preserve them as sub-headings inside the Steps section.
- If a step requires a tool (bash, file write, web search, etc.) say so explicitly.
- Keep each step short enough to be understood in one read (2–4 sentences max).
