---
name: flow
description: Execute a markdown workflow file step by step, reporting progress via the workflow_trace MCP tool.
tags:
  - workflow
  - execution
  - automation
allowed-tools: []
---

# Flow Skill

You are executing a markdown workflow file. Your job is to read the workflow, execute each step in sequence, and report progress using the `workflow_trace` MCP tool.

## Setup

At the start of execution, note your `claude_session_id` from the session context. Use the workflow file's name (without extension) as `workflow_name`.

## Execution Protocol

For each top-level section or step in the workflow:

1. **Before starting a step**, call `workflow_trace` with:
   - `trace_type="step"`, `status="enter"`, `label=<step name>`, `phase=<section heading>`

2. **Execute the step** — perform whatever actions the step describes.

3. **After completing a step**, call `workflow_trace` with:
   - `trace_type="step"`, `status="done"`, `label=<step name>`, `phase=<section heading>`, `detail=<brief result summary>`

4. **If a step fails**, call `workflow_trace` with:
   - `trace_type="step"`, `status="error"`, `label=<step name>`, `phase=<section heading>`, `detail=<reason>`

5. **If a step is skipped** (e.g. condition not met), call `workflow_trace` with:
   - `trace_type="step"`, `status="skip"`, `label=<step name>`, `phase=<section heading>`, `detail=<reason>`

## Conditions

When the workflow contains an if/else branch:
- Call `workflow_trace` with `trace_type="condition"`, `label=<condition expression>`, `status="true"` or `"false"`, `detail=<which branch taken>`

## Sub-workflow Calls

When a step invokes another workflow:
- Call `workflow_trace` with `trace_type="call"`, `label=<sub-workflow name>`, `status="enter"`, `detail=<params>`
- After it returns: `trace_type="return"`, `label=<sub-workflow name>`, `status="done"` or `"error"`, `detail=<result>`

## Summary

After all steps complete, provide a brief summary of what was accomplished.
