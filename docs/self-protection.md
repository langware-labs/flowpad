# Self-protection: a FlowPad activity never kills the FlowPad it runs inside

## The incident (FLOWPAD-2112)

In Vibe Mode on a remote Windows machine, an agentic worker killed FlowPad. The worker holds
the user's full permissions and runs as the same OS user as the backend. The leading cause:
the `flow-diagnose` skill prescribed `taskkill /PID <pid> /F` to free "port 9007" — and the
process holding 9007 **is** the backend. FlowPad killed itself.

## The invariant

> A live FlowPad activity is never killed or disrupted by another FlowPad activity.

Two sub-rules, both required:

- **May clean up** — a dead process, a stale port holder, the user's stuck `python`, or a
  worker's **own** child process. These are legitimate and must keep working.
- **Must not suicide** — the live backend (and, transitively, the processes that keep it
  running) are never taken down by a worker, a prompt, `flow-diagnose`, or a port-cleanup.

Protection is **by construction, in code** — not a system-prompt instruction telling the AI
what not to do. The AI does not have to choose to obey.

## The one rule

At every kill a FlowPad activity can reach, ask one question:

> Does the process about to die — **or anything in its process tree** — listen on one of
> **this instance's** protected ports?

If yes, refuse. Today the protected set is the **backend server port** (read live, per
instance — see below). That single question protects:

- the **backend** directly — it is the listener on the server port; and
- its whole **ancestor chain** — monitor, launcher, and the Electron shell — because the
  backend is a *descendant* in their trees, so any tree- or name-based kill that would reach
  them is refused on the backend's behalf.

It deliberately does **not** protect a worker's own children: the backend is their
*ancestor*, not a descendant, so `listening_under(worker_child)` never contains the server
port. A worker reaping its own stuck `python` stays allowed. (This is the one place the
design diverges from the original plan, which also refused *descendants* of the backend —
that would have made every worker child unkillable and broken the "may clean up" rule.)

No pid registry, no `create_time` sidecar files, no feature flag. The port is read from the
process table at the moment of the kill, so a backend that moved or restarted is protected
exactly as it runs now. With no FlowPad running, the protected set is empty and the guard is
a no-op.

## Resolving the protected port (per instance)

`port_guard.protected_ports()` returns `{backend port}`, from two live sources:

- `load_server_info()["port"]` — what the running backend recorded in `server.json`; and
- `get_instance_settings().port` — the instance's configured port (`LOCAL_SERVER_PORT`,
  else the instance default: prod `9007`, dev/test differ).

So a non-`prod` instance on a different port is protected without hardcoding `9007`, and a
kill aimed at **another** instance's backend (a different port) is never spared.

## Why not port 9222 (Electron CDP)

The original design also protected `9222`. Verified against the shipped Electron app: the
packaged desktop sets **no** `--remote-debugging-port` and **no** `--remote-debugging-pipe`
(`electron/main.js` sets only one unrelated switch). It exposes no Chrome DevTools endpoint
at all; every `9222` in the repo is a dev-only Chrome / `debugMCP` convention. So `9222` was
dropped — which also removes the risk of wrongly protecting a user's own Chrome that grabbed
the port. The Electron shell is instead protected transitively (it is an ancestor of the
backend).

## Where it is enforced

| Kill path | File | Behaviour |
| --- | --- | --- |
| `terminate_tree` | `flow_sdk/instances/procs.py` | Spares any tree member whose subtree holds a protected port; `allow_protected=True` reaps it. |
| `kill_owned` / `kill_port_if_owned` | `flow_sdk/instances/procs.py` | Pass `allow_protected` through; record a spared backend in `KillResult.refused`. |
| `kill_trees` | `flow_sdk/core/app_ports.py` | Spares protected members and never `killpg`s a group that still holds a protected listener. |
| `flow proc kill` | `flow_sdk/cli/commands/proc_cmd.py` | **Always** guards (no bypass). Name match is exact and excludes the caller's ancestor chain. Reports `refused_protected`. |
| `flow stop` | `flow_sdk/server/launch.py` (`_stop_all_guarded`) | A worker is refused with a clear non-zero `FlowServiceError`; a human proceeds. |
| `flow instance reset` / `restart-backend` | `flow_sdk/cli/commands/instance_cmd.py` (`_kill_instance_processes`) | A worker is refused (`RuntimeError`); a human passes `allow_protected=True` to reap its own backend. |
| service generation teardown | `flow_sdk/core/connections/service.py` (`_exact_cleanup`) | Trusted exact-identity teardown passes `allow_protected=True` (worker path blocked upstream). |

### User-requested vs worker kills

`flow stop` / `flow instance …` are user commands that legitimately stop the backend. The
backend stamps `FLOWPAD_EXECUTION_SCOPE` onto every worker it spawns (and children inherit
it); a human's terminal has none. So `port_guard.caller_is_worker()` cleanly tells the two
apart: a worker is refused loudly, a human proceeds. This is an **app-level** discriminator,
not a boundary — a determined worker can unset the variable, which is why the real boundary
for a raw OS kill is OS containment (below).

## Verification

- Unit tests: `tests/unit/test_port_guard.py` — a real helper process listens on a faked
  protected port; the whole live path (socket-table scan → tree walk) runs. Asserts: the
  listener and its ancestor are refused; a worker **child** of the listener is allowed; an
  unrelated process is killed; `terminate_tree` / `kill_trees` spare it (and its POSIX group)
  unless `allow_protected=True`; `flow proc kill` spares it and reports `refused_protected`;
  `--name` is exact and excludes the caller's ancestors; `caller_is_worker` reads the env var.
- Regression: the touched kill-path modules' existing suites pass unchanged.

## Residuals and follow-ups (not in this change)

- **Raw OS kill (L1).** A worker that bypasses Python entirely — `taskkill` / `kill` /
  `lsof | kill` — is outside this app-level guard. The real boundary is OS containment: a
  low-integrity / restricted worker token on Windows, a sandbox profile on macOS. Tracked as
  the L1 follow-up.
- **Startup gap.** Between the backend process starting and its socket entering `LISTEN`, the
  port-based check cannot see it. Brief, and the backend is not yet serving.
- **Monitor adopt-case.** When the monitor adopts an already-healthy backend instead of
  spawning it, the monitor is not the backend's parent, so killing the monitor alone is not
  refused — but the backend survives (it is not in the monitor's tree), so the app stays up.
- **JS / shell paths.** The Electron shell's own `uv-manager.js` port-kills and the
  `scripts/*.sh` launchers manage the backend directly; they are the app managing itself, not
  worker-reachable, and are out of scope for worker containment.
