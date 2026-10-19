---
id: a03e6341-3598-4d69-b0cc-d9aadb9a1024
---

# Chief of Staff — an agent that delegates through a task ledger

A checkbox on an Agent (`chief_of_staff`). With it on, the agent answers people fast and hands
longer work to its **staff** (SubAgents) as **tasks**. The chief and its staff talk only through
the **task ledger**; the chief hears its staff on its **Tasks channel**; only the chief talks to
people. Names: [glossary § Chief of Staff](../glossary.md).

## Each turn — one of three

| | When | How |
|---|---|---|
| **A** | it can answer now | answer — speed is the priority |
| **B** | a job under a minute | a native subagent in the same turn (Claude: the Agent tool, staff registered via `--agents`); a harness that cannot spawn makes it a task instead |
| **C** | anything longer | `flow task create --owner subagent:<name>` — "started, I'll get back to you" |

CoS.md (`task-management/chief-of-staff.md`) says this, rendered per harness by
`flow_sdk/tasks/cos.py:apply_to_launch` — the one seam `Deployment.create_process` calls, so chat,
channel turns, calls and scheduled launches all get it. Off, the launch is unchanged byte for byte
(`tests/api/test_chief_of_staff.py`).

## The flow

```
person ──channel──▶ chief turn ──flow task create──▶ ledger ──task.created──▶ runtime.dispatch
                                                        │                        │
                                                        │              headless run (owner), in
                                                        │              records_data/task/<id>/work
                                                        ◀── flow task start/note/ask/done ──┘
                                                        │
                           task.<event> on the bus ─────┼──▶ bus_sources → the chief's Tasks channel
                                                        │        → projected thread → serve loop → chief turn
                                                        └──▶ delivery → the run's prompt queue (replied, note, canceled)
chief turn ──flow conversation reply──▶ the person's own channel
```

- **Ledger** (`flow_sdk/tasks/ledger.py`) — the only writer. Row + Comment + `task.<event>` together;
  refuses what the caller's role may not do (`_BY`) or what the state forbids.
- **Identity** (`tasks/identity.py`) — never an argument: from the calling process. A task's run
  acts as its owner and only on its own task; an agent's worker as `agent:<id>`; a shell as `user:local`.
- **Runtime** (`tasks/runtime.py`) — one `task.*` subscriber: dispatch on `created`, deliver news to
  the run, free capacity on a terminal event, hold the budget. Started with the server.
- **Dispatch** (`tasks/dispatch.py`) — a run per subagent-owned task, on the creator's harness;
  `MAX_RUNS` per chief (the rest wait `submitted`); `budget_turns` / `budget_usd`; a quiet working
  task is announced `stalled` once. The run targets the task's thread on the Tasks channel, so the
  thread shows it live.
- **Tasks channel** (`data_driver/task_manager`) — `quiet_events` (created/started/note are the log,
  not a call to act), `turn_session` (answered in the session the task came from),
  `replies_explicitly` (the chief acts with `flow task reply` / `flow conversation reply`).
  `AgentServer` keeps one per chief, active while the box is ticked, written only when it changes.

## Where things live

**Authored configuration may live in the repo; runtime state never does.**

| | Where | In git |
|---|---|---|
| `chief_of_staff`, `subagents` | `agent.json` | yes |
| the Tasks channel | its `data_source.json` | yes (written once, then only on change) |
| a delegated task | DB + `~/.flow/instances/<name>/records/task/<id>/` (`placement="instance"`) | **no** |
| its comments, its run, its items | DB + records shadow | no |
| what a run makes | `records_data/task/<id>/work/` | no |
| a task a person **keeps** | `<project>/agentic-assets/task/<slug>/task.md` | yes — `flow task keep` / "Keep in project" |

A delegated task is never hub-synced (the ledger refuses a shared parent); a kept one can be shared.

## CLI

`flow task create | list | show | start | note | ask | reply | done | fail | cancel | keep` — one
JSON line each; a refusal exits 7. `flow conversation reply <id> <text>` speaks on the person's channel.

## Tests

- `tests/api/test_task_ledger.py` — the lifecycle, refusals, placement, keep.
- `tests/api/test_task_cli.py` — every verb through the real CLI, as the calling process.
- `tests/api/test_chief_of_staff.py` — gating per vendor; the checkbox → Tasks channel.
- `tests/api/test_chief_of_staff_flows.py` — every vendor × on/off end to end on MockWorker; ask
  round trip, cap, budget, stall.
- `tests/unit/test_mock_worker_modes.py`, `tests/unit/test_drain_stop.py`.
