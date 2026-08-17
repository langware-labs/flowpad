---
id: 7953ed01-9be0-5756-b063-39298f6c5186
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
    • process — restart the calling agentic-process session via ``flow process restart``
      (kills + re-spawns the worker, resuming the session). Use after installing an
      MCP server so the new config loads, or when the user says "restart this
      session / process / agent". Defaults to the current process. See ``process.md``.
    • message — send a message into a conversation, optionally carrying file
      attachments, entity references, or a runnable prompt for the recipient,
      via the backend's ``add_message`` HTTP action (``flow conversation send``
      covers text-only sends and nothing richer). Triggered by "send X to my
      conversation with Y", "attach this doc to the Z conversation", "message Y
      the report", "send them a prompt to run". See ``message.md``.
  NOT handled here: building a website / web app / SaaS / dashboard — even when
  phrased as "using flowpad assistant". That is the separate ``web-app-builder``
  skill (copy-as-is template + setup); invoke it instead of the records action.
  Also NOT handled here: building a slide deck / presentation / slideshow /
  pitch deck — even phrased as "using flowpad assistant". That is the separate
  ``decker`` skill; invoke it instead of the records action.
tags:
- flowpad
- ui
- navigation
- context
- records
- search
- message
allowed-tools:
- Bash(flow context list:*)
- Bash(flow navigate entity:*)
- Bash(flow schema list:*)
- Bash(flow schema info:*)
- Bash(flow record index:*)
- Bash(flow record search:*)
- Bash(flow show entity:*)
- Bash(flow show file:*)
- Bash(flow process restart:*)
- Bash(curl:*)
- Read
- Write
- Edit
---

# Flowpad assistance

A multi-action skill for the Flowpad app. Identify the requested action from the user message, then follow the matching section/file below. Actions can be composed: a request like *"create a task and open it"* is `records` (creating) followed by `navigate` (opening).

> **Building a website or web app is not an action of this skill.** If the
> user asks to build/create a website, web app, SaaS, dashboard, or landing
> page — even phrased as "build me a website using flowpad assistant" — stop
> and invoke the `web-app-builder` skill, which bootstraps a tested full-stack
> template into the session's working directory. Do not hand-write HTML/JS
> files or route this through `records`.

> **Building a slide deck or presentation is not an action of this skill.** If
> the user asks to build/create a slide deck, presentation, slideshow, pitch
> deck, or keynote — even phrased as "make me a deck using flowpad assistant" —
> stop and invoke the `decker` skill, which builds a deck template and
> generates a self-contained deck from it. Do not hand-write slide HTML or
> route this through `records`.

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
| process  | [`process.md`](process.md) |
| message  | [`message.md`](message.md) |

When composing actions (e.g. "navigate to the current X" or "create a task and open it"), read both files end-to-end before you start running commands.
