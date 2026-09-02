---
id: e5da519d-77ef-57fb-8adf-faf38d99b810
---

# AgenticProcess Architecture

`AgenticProcess` is the durable entity that represents an agent run. It is not
the PTY itself and it is not a frontend-only session. It coordinates process
metadata, worker CLI configuration, session history, and the optional terminal
runtime.

Current implementation:

- Backend: `flow_sdk/builtin/agentic_process/agentic_process.py`
- Backend drivers: `flow_sdk/builtin/agentic_process/cli_drivers/`
- Frontend entity: `ts_sdk/src/process/agentic-process.ts`
- Frontend status types: `ts_sdk/src/process/agentic-types.ts`

## Two Modes

The process has two independent axes, and it is important not to conflate them:

| Axis | Field | Question it answers | Consumers |
|------|-------|---------------------|-----------|
| **Transport** | `pty_mode` | How does a turn execute — interactive OS PTY, or headless `-p`/stream-json? | prompt routing, queue drain cold-start, dead-worker detection, the route loader's PTY attach |
| **Visibility** | `visible` | Is this process shown as a terminal tab? | tab-strip membership, footer worker chip, restart-recovery, the transcript-vs-terminal open path |

These were historically the same flag (`headless == !visible`), and the
chat⇄terminal toggle (`switch-mode`) still flips them **together** so the
shorthand usually holds. But they are now separate `APIField`s with separate
setters (`set-visible` vs the transport-carrying open/prompt paths), so code
must route on the correct axis:

- **Execution transport is `pty_mode`, never `visible`.** `prompt()`, the queue
  drain's cold-start gate, and dead-PTY detection all key on `pty_mode`
  (`agentic_process.py` ~2199, ~1652, ~3843). A comment or helper that says the
  turn path is "derived from `visible`" is describing the pre-decoupling model.
- **Tab visibility is `visible`, never the transport.** `set-visible`
  (`agentic_process.py:1783`) changes only whether a tab is shown; it must not
  kill the worker or reroute a turn.

| Transport (`pty_mode`) | Runtime | Default surface |
|------------------------|---------|-----------------|
| **PTY** (`true`) | Linked `Shell` starts a real OS PTY and runs the worker CLI interactively. | Terminal tab with xterm.js. |
| **Headless** (`false`) | Driver runs a headless print/prompt turn (`claude -p` stream-json) and streams structured `FlowData`. | SDK/programmatic flows, the headless chat surface, footer background chip. |

Both transports share the same `session_id` where the worker supports history.
For Claude, that session ID maps to the JSONL transcript in
`~/.claude/projects/<encoded-project>/<session_id>.jsonl`, so a session can be
switched between PTY and headless and resume in place.

> **Note on `WorkerMode` / `ExecutionMode`.** `status_predicates.get_worker_mode`
> and `worker_status.classify_execution_mode` still derive their result from
> `visible` (INTERACTIVE vs CLI / BACKGROUND). This is only correct while the two
> axes are in lock-step. `get_worker_mode` is consumed just by `switch-mode`'s
> label parsing; `classify_execution_mode` feeds the footer chip. Neither should
> be used to pick an execution path — see the "architectural concerns" note at
> the end of this file.

## Headless vs Non-headless: every behavioral divergence

The maintainer hypothesis is "the only difference is that a non-headless process
generates a tab." Tab generation is the most visible difference, but it is **not
the only one**. Tracing spawn → run → history → lifecycle, the divergences are:

1. **Tab strip vs footer chip.** A visible process is a terminal tab (its Tab
   entity is materialized through the terminal-strip path, not the generic
   `setupTab` — `shouldMaterializeDock` returns `false` for `AGENTIC_PROCESS`,
   `tab-lifecycle.ts:116`; see `docs/tab-management.md`). A headless process is
   not placed in the strip; it surfaces as a `BACKGROUND` chip in the footer
   worker list (`worker_status.classify_execution_mode`, `ExecutionMode.BACKGROUND`).
2. **Route-loader runtime phase.** `load-process.ts` (~199) attaches a PTY and
   resolves a `Shell` only when `pty_mode !== false`. Headless skips the PTY
   attach and the Shell entirely; there is no `shell_id`, and the chat streams
   over `flowDataStream`.
3. **Open / click behavior.** `openAgenticProcess` (`agentic-process-open.ts`)
   opens a live terminal for a visible worker but opens the **read-only
   transcript lens** for a headless one (`openLens('claude', 'transcript', …)`).
   A headless run is *viewed*, not attached.
4. **Restart recovery.** On backend restart, visible/watched PTYs are respawned
   with `--resume` (`run_pty_recovery`), while headless (`visible=false`) RUNNING/
   STARTING workers are **stamped `STOPPED`** by `reconcile_orphaned_workers`
   (`pty_recovery.py:126`) because a headless worker is not resumable in place.
   Note this recovery split keys on `visible`, not `pty_mode`.
5. **Cold-start via the prompt queue.** The queue drain will cold-boot a
   **headless** process for its first prompt (`_queue_ready`, gated on
   `not self.pty_mode`, `agentic_process.py:1652`). A PTY process is withheld
   from drain cold-start — its dock loader's `start()` owns the boot — to avoid
   racing the loader and losing the popped first prompt.
6. **Prompt transport.** `prompt()` routes on `pty_mode`
   (`agentic_process.py` ~2210): PTY → write to PTY stdin (or relaunch);
   headless → `driver.headless_prompt(...)`. A visible live-PTY process 409s the
   streaming CLI prompt path.
7. **Dead-worker detection.** Liveness keys on the transport: a headless worker
   has no persistent PID, so dead-PTY detection only applies when `pty_mode`
   (`agentic_process.py` ~3840). Headless "readiness" instead uses the
   `_turn_in_flight` flag.

Everything else — the durable entity, `session_id`/transcript, `WorkerStatus`
derivation, `cli_config`, history loading through the driver, `ready_for_input`
— is identical across the two.

## Backend Entity

The backend entity stores the durable state:

| Field | Purpose |
|-------|---------|
| `session_id` | Worker conversation ID. Replaces older `worker_session_id` terminology in the current entity API. |
| `status` | Stored lifecycle: `new`, `starting`, `running`, `stopping`, `stopped`, `failed`. |
| `worker_status` | Computed field exposed on serialization from worker transcript/history. |
| `ready_for_input` | Computed send-prompt predicate. |
| `visible` | Tab visibility only — whether the process is shown as a terminal tab. **Not** the transport selector (that is `pty_mode`). Set on open (`true`) / close (`false`); also settable in isolation via `set-visible`. |
| `pty_mode` | Durable transport intent: `true` → interactive PTY, `false` → headless JSON-stream. This is the routing key for `prompt`, queue cold-start, and the loader's PTY attach. Seeds `visible` at launch; the chat⇄terminal toggle keeps the two in lock-step. |
| `shell_id` | Linked `Shell` entity when a terminal runtime exists. |
| `cli_config` | Serialized CLI options, including model, permissions, chrome/debug/worktree, resume/fork metadata, add-dir, and agents. |
| `workdir` | Worker working directory. |

The entity resolves a vendor driver through
`flow_sdk/builtin/agentic_process/cli_drivers/get_driver`. Vendor details such
as CLI args, transcript lookup, history loading, status tail parsing, login
probing (`driver.auth_probe()`), and the device-login flow (the
`driver.device_login_spec` trait) belong to the driver layer rather than being
hard-coded throughout the entity. Two classmethod facades expose the harness
state: `AgenticProcess.is_installed(worker_type)` (reads the capability
discovery value — the same source actual spawns use) and
`AgenticProcess.is_logged_in(worker_type)`, which returns a `WorkerAuthResult`
(`not_installed` / `logged_in` / `logged_out` / `unknown`; "couldn't check" is
`unknown`, never `logged_out`). The result also carries an `auth_mode`
(`device` / `api`) describing how the harness authenticates.

A worker is funded one of three ways, and which one is decided per spawn by
`resolve_llm_source` (`cli_drivers/llm_source.py`) rather than read off a field.
It returns an `LLMSource` — the one value type covering all three — carrying
`eligible`/`reason`, `auto`, `authority` and `origin`, so the same list the picker
renders is the list a spawn chooses from, and a spawn failure is a rendering of it.

The ladder, most specific first: `AgenticProcess.llm_endpoint_typeid`, then
`Project.llm_endpoint_typeid`, then the user's explicit `Capability.auth_mode` /
`api_provider`, then the default order `device → api key → hub endpoint`. Everything
explicit is a constraint that fails loudly when it cannot be honoured; only the default
order yields. Resolution makes no network call.

The three sources, of which the first two are selected by the per-harness `Capability`
row's `auth_mode` field:

* **Device login** (`auth_mode = "device"`, the default) — the vendor's
  link(+code) sign-in flow, driven through the `Capability` entity's
  `device_login_spec` trait and `device-login`/`auth-status` actions.
* **API key** (`auth_mode = "api"`) — the harness spawns against a stored
  LLM-provider key instead of vendor credentials. The chosen provider lives in
  `Capability.api_provider`; the key is stored via `flow_sdk.lm_api`
  (`set_lm_api`/`get_lm_api`) in the per-instance secret store. Each driver
  declares an `ApiAuthSpec`
  (`flow_sdk/builtin/agentic_process/cli_drivers/api_auth.py`) with the
  provider env, model-tier→slug map, and codex `-c` config it needs;
  `resolve_worker_api_auth` folds that env into the spawn via
  `apply_worker_secret_env` and overrides the model slug before argv is frozen.
  `auth-status` reports `logged_in` iff a key is stored for the provider.
* **Hub `LLMEndpoint`** — the box spends a hub-authorized budget, signing with the
  hub login key it already holds (there is no `lm_api.flowpad` secret; see
  `flow_sdk/instance_settings/llm_endpoint.py`). The hub pushes the binding over the
  `llm-endpoint` box action after login. That push is an **offer**, not an order: it
  no longer rewrites `auth_mode`, so a user's stored choice survives it.

`Capability.auth_mode` is therefore a *preference* — what the user asked for, honoured
while it is available — not a record of what a given spawn actually did.

## PTY Mode Runtime

PTY mode is opened through `AgenticProcess.start()` on the backend and
`AgenticProcess.start({ visible: true })` on the frontend.

Flow:

```text
frontend start({ visible: true, instruction? })
  -> POST /agentic_process/<id>/open
  -> backend AgenticProcess.start()
  -> create/reuse Shell
  -> build worker CLI args through driver
  -> Shell.start(spawn_args, extra_env)
  -> desktop compute provider spawns OS PTY
  -> PTY bytes go to replay buffer and websocket
  -> frontend Shell.attachPty()
  -> PtyConnection replays and streams into xterm.js
```

The `Shell` owns the live terminal state:

- active PTY id (`shell.pty_pid`, returned from `open` as `pty_id`)
- worker PID where available
- attach/input/resize/close routing
- terminal replay chunks

The current `AgenticProcess` does not own a process-level `pty_pid`. Older docs
that describe `AgenticProcess.pty_pid` are describing a stale model.

## CLI Mode Runtime

CLI mode is the headless path. It runs when `pty_mode=false` (transport intent),
especially from `prompt()` or programmatic `executeInstruction()` calls that
expect structured `FlowData` instead of terminal bytes. Note the routing key is
`pty_mode`, not `visible` — `visible` only decides whether a tab is shown.

Flow:

```text
frontend prompt/executeInstruction
  -> backend AgenticProcess.prompt()
  -> if pty_mode=false: driver.headless_prompt(...)
  -> stream FlowData through the HTTP response/websocket processing path
  -> update transcript/history through the worker driver
```

If a process is visible and already has a live PTY worker, normal user input
should be sent through the terminal. The backend `prompt` action rejects the
streaming CLI prompt path for visible live PTY processes.

## Wizard Runtime

A wizard is an `AgenticProcess` used as an interactive setup assistant. It is a
process kind, not a separate execution system: the same entity, prompt routing,
FlowData stream, and chat surface are reused.

Generic launch flow:

```text
caller awaits launchWizard(name, data)
  -> WizardHost creates AgenticProcess kind="wizard"
     visible=false, pty_mode=false, loadFlowpadAssistant=true
  -> WizardHost opens a modal with EntityExecutionPanel
  -> initial prompt includes the caller's wizard data and close instruction
  -> user and agent interact in the same chat UI as other processes
  -> completion emits wizard.close
  -> AgenticProcess re-emits wizard.closed
  -> launchWizard resolves WizardProcessResult<T>
```

`WizardProcessResult<T>` is the typed boundary back to the caller:

```ts
{
  status: 'done' | 'cancel' | 'error'
  data: T | null
  errorStr?: string | null
}
```

There are two equivalent completion paths. The modal footer calls
`completeWizard(process, result)`, which posts the generic `entity-event`
`wizard.close`. An agent running inside the wizard can close itself with:

```bash
flow wizard <agentic_process_id> close '{"status":"done","data":{}}'
```

The backend handler validates the result, emits `wizard.closed` on the process,
and the frontend promise registered by `launchWizard` resolves. This keeps
domain setup flows decoupled from the UI: the git setup wizard, for example, is
just one wizard name and prompt using the same generic close protocol.

## Status Model

Status has two axes.

`ProcessStatus` is stored on the entity:

```text
new -> starting -> running -> stopping -> stopped
any -> failed
```

`WorkerStatus` is derived from worker history/transcript and exposed as
`worker_status`:

- `initializing`
- `idle`
- `waiting`
- `thinking`
- `tool_call`
- `tool_running`
- `api_error`
- `complete`
- `interrupted`
- `inactive`
- `api_timeout`
- `error`
- `unknown`

`ready_for_input` is true only when:

```text
status == running
and worker_status in { idle, complete, interrupted }
```

The transcript parser lives in `flow_sdk/fs_records/agent_status.py`. The
TypeScript mirror lives in `ts_sdk/src/process/agentic-types.ts`.

## Reconnect and Replay

PTY reconnection is handled by the shell/PTY stack, not by recreating the
`AgenticProcess`.

Relevant files:

- `flow_sdk/builtin/faas/pty_actions.py`
- `flow_sdk/compute/providers/desktop/provider.py`
- `flow_sdk/compute/providers/desktop/pty_session_manager.py`
- `flow_sdk/compute/providers/desktop/pty_replay_buffer.py`
- `ts_sdk/src/entities/shell.ts`
- `ts_sdk/src/services/shell/ptyConnection.ts`

Replay flow:

1. Backend assigns a monotonic sequence number to each PTY output chunk.
2. Browser tracks the highest sequence it has applied.
3. On attach/reconnect, browser sends `since_seq`.
4. Backend snapshots replay chunks before attaching the websocket connection.
5. Browser applies replay chunks, marks replay complete, then accepts live chunks.

This prevents terminal output loss during page refreshes, tab switches, and
websocket reconnects while the PTY is still alive.

## Main Actions

| Action | Purpose |
|--------|---------|
| `open` | Start or reattach PTY mode. |
| `exit` | Terminate live PTY worker while preserving process/session metadata. |
| `restart` | Exit then start again with current CLI config. |
| `fork` | Create a sibling process with fork metadata. |
| `prompt` | Run a headless CLI prompt stream for invisible processes. |
| `execute` | Execute instruction content through the prompt routing path. |
| `get-history` | Load worker history through the current driver. |
| `status` | Return lifecycle status, worker status, and readiness. |
| `close` | Close the process UI/runtime link and linked shell. |

## Frontend Flow

`ts_sdk/src/process/agentic-process.ts` is the canonical frontend entity.

Important methods:

- `start({ visible, instruction })`: calls backend `open`, syncs shell/process
  fields, and attaches PTY when visible.
- `prompt(text)`: headless CLI streaming path.
- `executeInstruction(...)`: sends instruction content and optionally waits.
- `fork(visible)`: creates a sibling process and starts it if requested.
- `restart()`: stops the current linked shell/worker and starts again.

The terminal UI is mounted from:

- `ui/src/routes/loaders/load-process.ts`
- `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`
- `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

The route loader opens the process in PTY mode before rendering the terminal.
The terminal then attaches to the linked shell, replays existing chunks, and
sends keyboard input through the shell's `PtyConnection`.

## Architectural concerns (transport vs visibility)

The `visible`/`pty_mode` decoupling is real in the data model and the hot paths,
but the derived helpers have not fully caught up, which leaves two mixed-axis
seams worth tracking:

- **`WorkerMode` / `get_worker_mode` still derive from `visible`**
  (`status_predicates.py:60`) even though the transport is `pty_mode`. Today this
  is only used by `switch-mode` label parsing, where `visible` and `pty_mode`
  move together, so it is correct by coincidence. If a caller ever sets
  `visible` in isolation via `set-visible` (a supported action) and then reads
  `get_worker_mode`, it will report the wrong transport. The safe fix is to
  derive it from `pty_mode`.
- **Restart recovery keys on `visible`, not `pty_mode`**
  (`reconcile_orphaned_workers`, `pty_recovery.py:157`; `run_pty_recovery`
  respawns visible PTYs). A process that is `pty_mode=true` but `visible=false`
  (a live PTY whose tab was hidden via `set-visible`) would be treated as a
  headless orphan and stamped `STOPPED` on restart rather than respawned. Whether
  that state is reachable in practice depends on whether any UI path hides a PTY
  tab without also flipping `pty_mode` — worth an explicit check.
- **`ExecutionMode.classify_execution_mode` labels the footer chip from
  `visible`.** A hidden-but-PTY process would be miscategorized as `BACKGROUND`.

None of these are bugs today (the toggle keeps the axes in lock-step), but they
are latent: every one assumes `visible == pty_mode`, which the decoupling
explicitly no longer guarantees. Consolidating all transport-derived helpers onto
`pty_mode` would remove the class of bug.
