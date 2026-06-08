# Action: process

Lifecycle control for an **agentic-process session** — the Claude/Codex worker
and its PTY behind a Flowpad terminal tab. Right now this exposes one verb:
**restart**.

Use it when the user (or you, mid-session) needs the worker re-spawned so it
re-reads its startup config. The headline case is **after installing an MCP
server**: MCP servers are loaded when the worker boots, so a freshly-installed
one is invisible until the worker restarts. Other triggers: *"restart this
session / process / agent"*, *"reload the agent"*, *"pick up the new MCP"*.

The session is **preserved** across the restart — the resumed worker continues
the same conversation (same transcript), it just boots with current config.

## How to restart

```bash
flow process restart
```

That is the whole invocation. With no flags it targets the **current** process
via `FLOWPAD_EXECUTION_SCOPE` (the session you are running in). To restart a
different session, pass its id:

```bash
flow process restart --process agentic_process-<uuid>
# or the bare id:
flow process restart -p <uuid>
```

## What happens (and why it returns immediately)

The command calls the backend `self-restart` action, which **schedules** the
restart on the server and returns right away — it does **not** block until the
worker is back. This is deliberate: a self-restart kills the very worker you are
running inside, and this CLI process is a child of that worker. If the restart
ran inline it would sever its own request mid-flight. By handing the work to the
server, the restart completes regardless, and the frontend terminal re-attaches
to the new PTY on its own (the action emits a `worker.restarted` event the UI
listens for).

**Consequence for a self-restart:** this command — and your whole session — is
replaced moments after it returns. So make `flow process restart` the **last
thing you do** in a turn, and tell the user what is happening *first*, e.g.
*"Installed the MCP server — restarting this session so it loads; I'll continue
once it's back."* Don't queue more work after it; the resumed worker picks up
from the conversation history.

## Output

Success — exit 0, single JSON line on stdout:

```json
{
  "ok": true,
  "process_id": "<uuid>",
  "scheduled": true,
  "status": "running",
  "id": "<uuid>",
  "note": "Restart scheduled. If this is a self-restart, the session is being replaced now."
}
```

## Exit codes

| Exit | Meaning |
| ---- | ------- |
| `0`  | OK — restart scheduled. |
| `2`  | No target: not inside an AgenticProcess and no `--process` given. |
| `5`  | Cannot reach the Flowpad server. |
| `7`  | The action failed server-side (message in the JSON). |

## Typical sequence: install an MCP, then restart

1. Install / configure the MCP server (e.g. add it to the agent's MCP config).
2. Tell the user you're about to restart so it loads.
3. `flow process restart`
4. Stop — the session is being replaced. Continue after it resumes.
