---
id: 20b72684-1376-4f63-bb14-a286062b3097
name: task-management
description: >-
  The task ledger — how a Chief of Staff agent hands long work to a subagent and how the subagent
  that owns a task reports back. Covers `flow task create/list/show/start/note/ask/reply/done/fail/cancel`,
  the task states, the events each side receives, and `flow conversation reply`. Use whenever you
  create, own, or receive news about a task. NOT for the user's personal to-do list (flowpad-assistance).
tags:
- tasks
- delegation
- chief-of-staff
allowed-tools:
- Bash(flow task:*)
- Bash(flow conversation reply:*)
---

# Task management

A **task** is work one principal hands another. It has a **creator** (who asked — usually a Chief
of Staff agent), an **owner** (who does it — a subagent), a **brief** (the contract), the
conversation it came from, and a status:

```
submitted → working ⇄ input_required → done | failed | canceled
```

Every change is written through `flow task …`: it moves the status, adds a line to the task's log
(its thread on the Tasks channel), and tells the other side. You never poll — news arrives as your
next message, shaped like:

```
[task <id> · <event> · by <who>] <title>
<text>
```

Who you are is never an argument: the ledger reads it from your process. Read the guide for your role:

- **You created the task (Chief of Staff)** → [creator.md](creator.md)
- **You own the task (a subagent)** → [owner.md](owner.md)

## Commands

| Command | Who | What |
|---|---|---|
| `flow task create --title T --brief B [--owner subagent:<name>]` | creator | Hand a task off (default owner `subagent:general-worker`). |
| `flow task list [--thread current]` | both | Your open tasks (this conversation's). |
| `flow task show <id>` | both | The task and its whole log. |
| `flow task start <id>` | owner | You are working on it. |
| `flow task note <id> "…"` | both | A progress line. |
| `flow task ask <id> "question?"` | owner | You need an answer; the task waits. |
| `flow task reply <id> "answer"` | creator | Answer the owner's question. |
| `flow task done <id> --result "…" [--artifact PATH]` | owner | Finished. |
| `flow task fail <id> "why"` | owner | It cannot be done. |
| `flow task cancel <id> "why"` | creator | No longer needed. |
| `flow conversation reply <conversation> "…"` | creator | Tell the PERSON, on their channel. |

Each prints one JSON line; a refusal (not yours, wrong state) exits 7 with the reason.
