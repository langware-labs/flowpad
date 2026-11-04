# Self-protection: a FlowPad activity never kills the FlowPad it runs inside

## The incident (FLOWPAD-2112)

In Vibe Mode on a remote Windows machine, an agentic worker killed FlowPad. The worker holds
the user's full permissions and runs as the same OS user as the backend. The leading cause:
the `flow-diagnose` skill prescribed `taskkill /PID <pid> /F` to free "port 9007" — and the
process holding 9007 **is** the backend. FlowPad killed itself.

## The invariant

> A live FlowPad activity is never killed or disrupted by another FlowPad activity.

Two sub-rules, both required:

- **May clean up** — a dead process, a **stale/foreign port holder**, the user's stuck
  `python`, or a worker's **own** child process. These are legitimate and must keep working.
- **Must not suicide** — the live backend (and, transitively, the processes that keep it
  running) are never taken down by a worker, a prompt, `flow-diagnose`, or a port-cleanup.

Protection is **by construction, in code** — not a system-prompt instruction telling the AI
what not to do.

## The one rule

At every kill a FlowPad activity can reach, the kill is evaluated per **root** (each process
the caller actually aimed at):

> Is this root **the live backend of this instance**, or an **ancestor that has the live
> backend somewhere beneath it**? If so, refuse it (whole).

That protects:

- the **backend** directly; and
- its whole **ancestor chain** — monitor, launcher, Electron — because the backend sits
  beneath them, so a tree/name kill that would reach them is refused on the backend's behalf.

It deliberately does **not** protect the backend's *descendants* (workers, their shells, MCP
servers, web apps): the backend is their *ancestor*, so a worker reaping its own stuck
`python` or a tree it spawned stays allowed. A refused root is spared **whole** — its subtree
and (on POSIX) its process group are never collected — so killing "from above" the backend
never sweeps the backend's siblings along with it.

## Identifying the live backend (not "whoever holds the port")

`port_guard.live_backend_pid()` returns the backend's pid from the backend's **own**
`server.json` record — `server_pid` plus `server_create_time` — confirmed to still be that
live process. It is **not** "the process listening on the port":

- When the backend has died and a stale `python` (or a foreign program) is left holding the
  port, that holder is **not** the recorded live backend, so it stays **killable** — which is
  exactly what "may clean up a stale port holder" requires, and what lets FlowPad start again.
- `server.json` is the backend's self-record written at startup (`server/app.py`), per
  instance — so a non-`prod` instance on a different port is covered without hardcoding
  `9007`, and another instance's backend (a different record) is never spared here.

With no live recorded backend, the guard protects nothing (fail open — there is no FlowPad to
protect). Cost per kill is one `server.json` read plus one tree walk per root — never a scan
of every listener on the machine.

## Why not port 9222 (Electron CDP)

An earlier design also protected `9222`. Verified against the shipped Electron app: the
packaged desktop sets **no** `--remote-debugging-port` and **no** `--remote-debugging-pipe`
(`electron/main.js` sets only one unrelated switch). It opens no Chrome DevTools endpoint at
all; every `9222` in the repo is a dev-only Chrome / `debugMCP` convention. So `9222` was
dropped, and the Electron shell is protected transitively (it is an ancestor of the backend).

## Where it is enforced

| Kill path | File | Behaviour |
| --- | --- | --- |
| `terminate_tree` | `flow_sdk/instances/procs.py` | Drops a protected root (backend / ancestor) **before** expansion, so the backend's own children are not swept along; `allow_protected=True` reaps it. |
| `kill_owned` / `kill_port_if_owned` | `flow_sdk/instances/procs.py` | Pass `allow_protected` through; record each spared pid in `KillResult.refused` so a refusal is visible, not read as success. |
| `kill_trees` | `flow_sdk/core/app_ports.py` | Skips a protected root whole (its tree and its process group) and never `killpg`s a group still holding the live backend. |
| `flow proc kill` | `flow_sdk/cli/commands/proc_cmd.py` | **Always** guards (no bypass). `--name` matches by base name (`python` ↔ `python3.11`) and excludes the caller's ancestor chain; reports `refused_protected`; exits non-zero when nothing was selected. |

### Lifecycle commands: gated for a worker on its OWN instance only

`flow stop` and `flow instance reset` / `restart-backend` reap the backend by design
(`allow_protected=True`), so the port guard above does not stop them. But a **worker** that runs
one against **the instance it lives in** would stop its own FlowPad — the exact incident — so
that one case is refused, loudly (a clear error, non-zero exit):

- `flow stop` reaps the backend of the instance `FLOW_INSTANCE` names; it is refused only for a
  worker whose **own** backend that is.
- `flow instance reset <name>` / `restart-backend <name>` is refused only for a worker reaping its
  **own** backend. A worker managing a **different** instance (`qa`, `dev`, on another port) is
  **not** blocked.

"Its own backend" is decided by **process ancestry** (`port_guard.runs_under`): the target's
recorded `server_pid` — **or its recorded `monitor_pid`** — is this process or one of its
ancestors. Ancestry, not a `FLOW_INSTANCE` or `live_backend_pid()` match — both of those follow a
`FLOW_INSTANCE=<other> flow stop` override and would wrongly flag a different instance, whereas the
live process tree cannot be spoofed by an env var. The `FLOWPAD_WORKER` signal is also stripped
from any backend/monitor a worker launches (the one detached-spawn chokepoint), so it never leaks
to infrastructure or to a terminal opened from it.

The **monitor** is checked alongside the server because `flow stop` (and the instance sweep) reaps
every monitor *first*, and the monitor is an ancestor of the backend — hence of the worker. For
roughly 15s after a restart (see `get_status`) the backend has not yet recorded its `server_pid`,
so a server-only check would fail open in exactly the window a worker is most likely to run
`flow stop`; the monitor's pid is already in the lock sidecar by then, so checking it closes the
window.

**Ancestry is read from the live tree, so a severed chain fails open.** If `runs_under` cannot walk
the ancestry (a `psutil`/OS error, an intermediate process that already exited, or a worker
detached with `setsid`/`nohup` and reparented to init), it returns `False` and the gate does **not**
refuse — it logs a warning so the gap is observable. That residual is deliberate: a worker that has
been cut loose from the backend's tree is no longer identifiable as "running inside" it at the app
layer, and the real boundary for a detached or raw-kill worker is L1 (OS containment).

The signal is **`FLOWPAD_WORKER`** (`flow_sdk/utils/environment.py`), stamped `"1"` on every
worker spawn at the one chokepoint (`apply_worker_env`) and inherited by a worker's children. It
is deliberately **not** `FLOWPAD_EXECUTION_SCOPE`: that is a process-*attribution* signal set in
**both** a worker **and** the FlowPad desktop terminal (where a human types), so it cannot tell a
human from a worker — gating on it would block a human and every other instance. `FLOWPAD_WORKER`
is set nowhere but the worker-spawn path, so a human in the desktop terminal never carries it.

This is still an app-level gate (L0): a worker that bypasses Python with a raw `taskkill` / `kill`
is contained at the OS boundary (L1). The port guard also spares the live backend on every
non-lifecycle kill path (the incident class: a broad "free the port" / "kill python" /
`flow proc kill`).

## Verification

- Unit tests: `tests/unit/test_port_guard.py` build a real `root → backend → worker` process
  tree (only `live_backend_pid` is faked, to the helper's pid) and assert: the backend and its
  ancestor are refused; the worker **child** is allowed; a **stale port holder is killable**
  (no live backend → not protected); `terminate_tree` / `kill_trees` spare the ancestor tree
  **whole** (backend and its worker survive) unless `allow_protected=True`; `flow proc kill`
  reports `refused_protected`, matches `python`→`python3.x`, and exits non-zero on no match.
- Regression: the touched kill-path suites pass unchanged.

## Residuals and follow-ups (not in this change)

- **Raw OS kill, and deliberate `flow stop` / `flow instance`, by a worker (L1).** A worker
  that bypasses Python (`taskkill` / `kill` / `lsof | kill`), or that deliberately invokes a
  lifecycle command to stop its own backend, is outside this app-level guard. The real
  boundary is OS containment: a low-integrity / restricted worker token on Windows, a sandbox
  profile on macOS. Tracked as the L1 follow-up.
- **Startup gap.** Between the backend recording `server.json` at startup and a kill reading
  it, there is a brief window with no identity to protect.
- **JS / shell paths.** The Electron shell's own `uv-manager.js` port-kills and the
  `scripts/*.sh` launchers manage the backend directly; they are the app managing itself, not
  worker-reachable, and are out of scope for worker containment.
