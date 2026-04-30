---
name: flowpad-assistance
description: |
  Flowpad assistance — drives the Flowpad app on behalf of the user. Supported actions:
    • context — read what the user is currently looking at (current project,
      process, workspace, etc.) so other actions can compose without asking
      for an id. Triggered by phrases like "current X", "this X", "the
      one I'm in".
    • navigate — drive the active browser tab to a Flowpad entity by TypeId
      (e.g. "shell-<uuid>", "markdown-<uuid>", "project-<uuid>",
      "agentic_process-<uuid>"). Triggered when the user asks to open, show,
      navigate to, or jump to an entity. See ``navigate.md``.
    • records — entities/records CRUD. Discover types via ``flow schema list``,
      get the JSON shape via ``flow schema info <type>``, materialize a
      record on disk, then run ``flow record index <path>`` to persist it.
      Triggered by "create a task / skill / agent / workflow", "make a new
      X", "add an X". See ``records.md``.
    • search — Search local files, skills, agents, specs, plans and other
      assets via ``flow record search <query> <time> <limit>`` (SQLite FTS5).
      Use this whenever the user asks to find / look up / show / search for
      something without giving an explicit TypeId. See ``search.md``.
tags:
  - flowpad
  - ui
  - navigation
  - context
  - records
  - search
allowed-tools:
  - Bash(flow context list:*)
  - Bash(flow navigate entity:*)
  - Bash(flow schema list:*)
  - Bash(flow schema info:*)
  - Bash(flow record index:*)
  - Bash(flow record search:*)
  - Read
  - Write
  - Edit
---

# Flowpad assistance

A multi-action skill for the Flowpad app. Identify the requested action from the user message, then follow the matching section/file below. Actions can be composed: a request like *"create a task and open it"* is `records` (creating) followed by `navigate` (opening).

## Action: context

Read the per-tab data-context the UI mirrors to the server. Use this whenever the user refers to "the current X" / "this X" / "the one I'm looking at" instead of giving an explicit TypeId.

### How to read context

```bash
flow context list
```

That is the entire invocation. No flags needed for the active tab. Pass `--connection-id <id>` only if the user explicitly names a different connection.

### Output

Success — exit 0, one JSON line on stdout:

```json
{
  "ok": true,
  "connection_id": "...",
  "context": {
    "CurrentProjectTypeId": "project-<uuid>",
    "CurrentProcessTypeId": "agentic_process-<uuid>",
    "CurrentWorkspaceTypeId": "workspace-<uuid>",
    "CurrentComputeNodeTypeId": "compute_node-@local",
    "CurrentUserTypeId": "user-<uuid>",
    "CurrentActiveEntityTypeId": null,
    "CurrentDomainTypeId": "...",
    "CurrentVisitorTypeId": null,
    "CurrentAgentTypeId": null,
    "CurrentWorkflowTypeId": null,
    "CurrentFlowTypeId": null
  }
}
```

Each value is a TypeId string (`<type>-<id>`) or `null` if not set. The exit codes match other actions: `3` no active tab, `4` connection not found, `5` server unreachable.

### Mapping user phrases → keys

| User phrase | Read this key |
| --- | --- |
| "current project" / "this project" | `CurrentProjectTypeId` |
| "current process" / "this agent" / "this session" | `CurrentProcessTypeId` |
| "current workspace" | `CurrentWorkspaceTypeId` |
| "current compute node" / "this machine" | `CurrentComputeNodeTypeId` |
| "current user" / "me" | `CurrentUserTypeId` |
| "current agent" | `CurrentAgentTypeId` |
| "current workflow" | `CurrentWorkflowTypeId` |
| "current flow" | `CurrentFlowTypeId` |
| "active entity" / "what I'm focused on" | `CurrentActiveEntityTypeId` |

If the matched key is `null`, tell the user that nothing is set for that scope — do not guess or fall back to a different entity.

## Other actions

For any action other than `context`, open the matching file in this skill directory and follow it literally. Do not improvise from the action summaries above — those are routing hints, not specifications.

| Action | File |
| --- | --- |
| navigate | [`navigate.md`](navigate.md) |
| records  | [`records.md`](records.md) |
| search   | [`search.md`](search.md) |

When composing actions (e.g. "navigate to the current X" or "create a task and open it"), read both files end-to-end before you start running commands.