---
id: 7953ed01-9be0-5756-b063-39298f6c5186
name: flowpad-assistance
description: >-
  Drives the Flowpad app on behalf of the user: reads the current context (project,
  process, workspace) so other actions compose without needing an id; creates and
  indexes records (tasks, skills, agents, workflows); searches local assets via FTS;
  restarts the calling agentic-process; reads messages the user received ("X sent me
  a message") and sends messages with attachments into a conversation. Use for "the current X" / "this X", "create a task / skill / agent",
  "find or look up X", "restart this session", "what did X send me", or "send X to my
  conversation with Y".
  NOT for showing or opening something in the UI (flowpad-navigation), building a
  web app (web-app-builder), or a slide deck (decker).
tags:
- flowpad
- context
- records
- search
- message
allowed-tools:
- Bash(flow context list:*)
- Bash(flow schema list:*)
- Bash(flow schema info:*)
- Bash(flow record index:*)
- Bash(flow record search:*)
- Bash(flow show entity:*)
- Bash(flow show file:*)
# The third `flow show` form. Entities and files were allow-listed and SCREENS were
# not, so the one target kind that needs no id was the one this skill could not open.
- Bash(flow show view:*)
- Bash(flow schema views:*)
- Bash(flow process restart:*)
- Bash(curl:*)
- Read
- Write
- Edit
---

# Flowpad assistance

A multi-action skill for the Flowpad app. Identify the requested action from the user message, then follow the matching section/file below. Actions can be composed. **Showing or opening anything in the UI is not an action of this skill** — a request like *"create a task and open it"* is `records` here, then the `flowpad-navigation` skill for the opening half.

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

For any action other than `context`, open the matching file in this skill directory and follow it literally. Do not improvise from the table below — the files are the specification.

| Action | File |
| --- | --- |
| records  | [`records.md`](records.md) |
| search   | [`search.md`](search.md) |
| process  | [`process.md`](process.md) |
| message  | [`message.md`](message.md) — read what someone sent (Flowpad conversations, never Slack/Gmail unprompted; needs cloud login) or send |

When composing two actions in this skill (e.g. `search` then `records`), read both
files end-to-end before you start running commands.
