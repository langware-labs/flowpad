---
id: d8d149e9-2f0b-5f37-90ed-8a8eefe83212
---

# Agentic-process flows (test-derived)

> **Status model note.** Transport routing keys on `pty_mode` (never `visible`),
> and the wire `status` is the logical `ready`/`busy` projection of stored
> `running`. See
> [docs/agent/agentic_process_statuses.md](../agent/agentic_process_statuses.md)
> for the current three-axis model.

The canonical end-to-end flows of the agentic-process stack, reconstructed from the
reference tests that exercise each one. Every step names the **actual** API call at
each layer (TS SDK call → backend graph action → Python method), so this doubles as a
map of what a caller must know today.

Related interface docs (relative to this file):
[agentic-process](./agentic-process.md) ·
[shell](./shell.md) ·
[pty-layer](./pty-layer.md) ·
[compute-node](./compute-node.md) ·
[cli-drivers](./cli-drivers.md) ·
[status-model](./status-model.md)

Two routing facts recur throughout and are worth stating once:

- **`pty_mode` is the durable transport selector.** `True` means interactive PTY;
  `False` means headless print-mode streaming. Print-mode streaming (the
  `flow-status`/`flow-chat`/`flow-end` frames) is reached when `pty_mode=False`.
- **`visible` is tab visibility.** Launch and mode-switch flows commonly keep
  `visible` and `pty_mode` in lock-step, but execution routers must not derive
  transport from `visible`. See [status-model](./status-model.md) for how these
  interact with worker status.

---

<a id="headless-execute"></a>
<a id="headless-turn"></a>
## #headless-execute — spawn → execute → streamed output, no PTY

The simplest agentic turn: create a headless process, feed it one instruction, drain the
streamed reply. No terminal, no PTY.

| # | Layer | Call |
|---|-------|------|
| 1 | TS SDK | `new AgenticProcess({ workdir }).save([])` |
| 2 | TS SDK | `proc.watch()` — subscribe to the entity's DataOps over WS |
| 3 | TS SDK | `proc.executeInstruction('Say hola', { sync: false })` |
| 4 | backend | `POST /api/v1/graph/agentic_process/{id}/prompt` (headless transport, `pty_mode=False`) |
| 5 | Python | worker runs in print mode; stdout is framed into `flow-status` / `flow-chat` / `flow-end` XML |
| 6 | TS SDK | `for await (const item of proc.output())` yields `FlowData` (`elementType` CHAT/TEXT) |

Underlying wire flow, from the streaming test: `createProcess` with
`{ pty_mode: False, visible: False, output_format: "stream-json" }` then
`POST …/prompt` returns a 200 streaming body whose XML contains `<flow-status`,
`<flow-chat`, `<flow-end`, and closes on `</flow-end>`.

**Reference tests**
- `ui/tests/long_tests/agentic_process_execute.test.ts` — single-turn (`hola`) and
  multi-turn (two sequential `executeInstruction` calls); drives the real Claude subprocess
  and the `output()` generator. Turn 2 subscribes to the `complete` event before firing,
  because `workerStatus` is already terminal from turn 1 and `output()` would exit
  immediately (lines 118-133).
- `tests/long_tests/test_agentic_process_prompt_streaming.py` — asserts the
  `flow-status`/`flow-chat`/`flow-end` frame contract on the streaming `prompt` body
  (lines 100-122).
- `tests/api/test_agentic_process_execute.py` — headless `execute` / `prompt` /
  `cancel-prompt` round-trips via HTTP (session-id capture, streamed FlowData+end,
  in-flight cancel). (Was a 0-byte stub before the 2026-07-02 coverage expansion.)

**Slickness:** Clean on the TS side — `save → watch → executeInstruction → output()` reads
like an obvious four-step API. The rough edge is that the caller must know the
`pty_mode/visible` matrix to reach print-mode framing at all (step 4).

---

<a id="pty-attach"></a>
<a id="pty-launch"></a>
## #pty-attach — create → open → Shell/PTY attach

Bring up an interactive worker with a live PTY and a linked [Shell](./shell.md) entity.
The tests cover two entry points.

<a id="create-process"></a>
<a id="resolve-local"></a>
<a id="worker-launch"></a>
<a id="pty-start"></a>
**Top-down (process first, then PTY):** step 2 is `createProcess`
([#create-process](#create-process), the [compute-node](./compute-node.md) action); steps 3-4
are worker launch / PTY start ([#worker-launch](#worker-launch), [#pty-start](#pty-start), the
[pty-layer](./pty-layer.md) spawn).

| # | Layer | Call |
|---|-------|------|
| 1 | backend | `GET /api/v1/graph/bootstrap` → `data.default_compute_node.id` |
| 2 | backend | `POST /api/v1/graph/compute_node/{cn}/createProcess` `{ visible: True }` → `process.id` |
| 3 | backend | `POST /api/v1/graph/agentic_process/{id}/open` `{ instruction: "echo hello world" }` |
| 4 | Python | `_perform_open` spawns the PTY, links a Shell; returns `{ shell_id, session_id }` |
| 5 | backend | `GET /api/v1/graph/agentic_process/{id}` → entity now carries `shell_id` + `session_id` |
| 6 | backend | `POST /api/v1/graph/agentic_process/{id}/exit` (teardown; Shell kept, status→idle) |

<a id="pty-reattach"></a>
**Re-attach to a live PTY** ([#pty-reattach](#pty-reattach)): a client re-binds to an
already-spawned PTY (page refresh, mode toggle) via the Shell's `attachPty` →
`terminal-command/attach` on the [pty-layer](./pty-layer.md), which streams the framed `.pty`
replay buffer rather than spawning a new worker. Distinct from [#pty-start](#pty-start) (fresh
spawn) and [#pty-resume](#pty-resume) (respawn with `--resume` after the worker died). This path
has no dedicated Python test here; it is exercised transitively by the recovery and mode-switch
suites (`agentic-process-switch-mode.test.ts` asserts the `restarted` emit that triggers the
terminal's re-attach) — see [Findings](#findings).

**Bottom-up (worker discovered from disk, AP synthesized):** two idempotent entry points —

- `POST /api/v1/graph/compute_node/{cn}/upsertSessionProcess` `{ sessionId }` → creates (or
  returns the existing) AP bound to that session; a second call with the same `sessionId`
  returns the **same** AP id. Once a session has started, a later upsert with a different
  `workdir`/`projectId` is a **no-op** — the `(workdir, project_id)` binding is frozen to keep
  the record aligned with where the transcript lives (incident 4c5bd6e4).
- `GET /api/v1/graph/compute_node/{cn}/terminals/get_by_worker_id/{sessionId}` →
  auto-discovers the on-disk Claude/Codex transcript, **atomically upserts** an AP *and*
  spawns its linked Shell (`shell_id` populated), returning the descriptor;
  idempotent on repeat.
- `GET /api/v1/graph/compute_node/{cn}/findSession?session_id=…` → resolves a raw session id
  to `{ session_id, worker_type, transcript_path, cwd }` (404 + FAIL when unknown). This is
  the read-only lookup the two upsert paths sit on top of.

**Reference test:** `tests/api/test_pty_process_e2e.py`
- top-down: `test_open_pty_creates_pty_session` (lines 32-86)
- bottom-up upsert + idempotency + binding-freeze: `test_upsert_session_process`,
  `test_upsert_session_process_does_not_rebind_started_process` (lines 89-181)
- discovery: `test_find_session_claude/codex/404`, `test_get_by_worker_id_claude/codex/404`
  (lines 236-390)
- PTY env: `test_flowpad_pty_pid_in_env` asserts `FLOWPAD_PTY_SESSION_ID` is set (lines 393-402)

**Slickness:** Top-down is a clean 3-call ceremony (bootstrap → createProcess → open).
The bottom-up story is **not** a single "raw PTY → elevate → process" call as one might
expect — there is no `elevate-pty` action in this suite. Instead the caller picks between
`upsertSessionProcess`, `terminals/get_by_worker_id`, and `findSession` depending on whether
they want a spawn, a discovery-upsert, or a lookup. See [Findings](#findings).

---

<a id="prompt-streaming"></a>
## #prompt-streaming — prompt streams in BOTH transports

`prompt` is a **single** endpoint with two transports keyed off `pty_mode`. The older
"PTY processes reject with 409" contract no longer holds — both return 200.

| Transport | createProcess body | What streams |
|-----------|--------------------|--------------|
| Headless (print mode) | `{ visible: False, pty_mode: False, output_format: "stream-json" }` | print-mode worker stdout, framed as `flow-status` → `flow-chat` → `flow-end` |
| PTY | `{ visible: True }` | the PTY session transcript (`_run_pty_prompt`); still yields `<flow-` frames |

Both:
1. `POST /api/v1/graph/compute_node/{cn}/createProcess` (body per table) → `process.id`
2. `POST /api/v1/graph/agentic_process/{id}/prompt` `{ message }` → 200 streaming body

**Reference test:** `tests/long_tests/test_agentic_process_prompt_streaming.py`
- `test_prompt_streams_xml_flowdata_for_trivial_turn` (headless, lines 100-122)
- `test_prompt_admits_visible_process_via_pty_transport` (PTY, lines 125-160)

Runs against the **already-running** hub (`FLOWPAD_HUB_URL`, must be a dedicated instance,
never the main dev backend) rather than an in-process test client — the bootstrap path scans
the filesystem and hangs on transient tmp paths.

**Slickness:** Good — one endpoint, transport chosen by the entity's own `pty_mode` flag,
identical `<flow-` frame contract on both sides. The unification is the slick part.

---

<a id="mode-switch"></a>
## #mode-switch — headless ⇄ interactive

One logical session, transport flipped in place. The single backend seam is the
`switch-mode` action; the toggle updates both `visible` and `pty_mode` in the
normal UI flow, while execution routing continues to key on `pty_mode`.

| # | Layer | Call |
|---|-------|------|
| 1 | TS SDK | `proc.switchMode(WorkerMode.CLI)` or `WorkerMode.Interactive` |
| 2 | backend | `POST …/switch-mode` `{ mode: "cli" \| "interactive" }` |
| 3a | Python (cli) | kill PTY intent, persist `visible=False`, `pty_mode=False` → `ApiSuccessResponse` |
| 3b | Python (interactive) | dispatch `_perform_open(instruction=None, visible=True, retry=True)` |
| — | Python (bad mode) | `ApiFailResponse` "unknown mode" — not a silent no-op |

On the TS side, `WorkerMode.Interactive` does **not** call `switch-mode` — it routes through
`start()` → the `open` action for the live attach, then `emit('restarted')` so the terminal
clears and re-attaches the fresh PTY. `WorkerMode.CLI` calls `switch-mode {mode:'cli'}` and
mirrors `visible=false`/`pty_mode=false` locally.

**Reference tests**
- `tests/unit/test_agentic_process_switch_mode.py` — cli flips to headless, interactive
  routes to `_perform_open(instruction=None, visible=True, retry=True)`, bogus mode → FAIL
  (lines 49-95).
- `ui/tests/unit/agentic-process-switch-mode.test.ts` — CLI calls `switch-mode {mode:cli}`
  and flips local flags; Interactive calls `open` and emits `restarted` (lines 49-85).

**Slickness:** Asymmetric. CLI is one action; Interactive is a *different* action (`open`)
plus a client-side `restarted` emit. The two directions of one toggle don't share a seam.
See [Findings](#findings).

---

<a id="restart"></a>
## #restart — restart + `restart_required` glow contract

Editing a launch-affecting field on a running worker sets `restart_required` (the UI "glow");
a real restart clears it. Powered by a **stable snapshot hash** captured at each successful
`start()`.

Save-hook contract: on save, if `_restart_snapshot()` ≠ `last_started_hash` **and** the gate
(`status == RUNNING && last_started_hash` set) passes, flip `restart_required = True`.

| # | Layer | Call |
|---|-------|------|
| 1 | TS SDK | `new AgenticProcess({}).save([])` → `proc.start()` (captures `last_started_hash`, flag off) |
| 2 | TS SDK | mutate a tracked field (e.g. `cli_config.model`) → `proc.save()` → `restart_required` flips True |
| 3 | TS SDK | `proc.restart()` → backend `start()` success path captures a fresh snapshot, clears the flag |
| — | backend | `POST …/restart-info` → `{ loaded, current, changed[], running, restart_required, worker_type }` for the "why restart?" debug viewer |

Snapshot stability is the whole game: the hash must be identical across every
construction/hydration path (string vs `WorkerType` enum for `worker_type`, null vs missing
optional CLI keys). `worker_type` is keyed to the **driver name** (`"claude"`), normalized to
`.value` — not Python's default `"WorkerType.CLAUDE_CODE"` `__str__` form (the original
~700ms-after-start false flip).

Tracked signals include `cli_config.*`, `additional_dirs`, `embedded_agent_ids`,
`shell_mode`, `load_flowpad_assistant` (rides on worker `add_dirs`), and `pty_mode` for Codex
(interactive vs `codex exec --json` shapes differ). Explicitly **not** tracked: `name`,
`tags`, `labels`, `visible`, `plan_path`, `favorite_index`. `workdir` is frozen post-start
(binding freeze), so it never drifts.

**Reference tests**
- `tests/unit/test_agentic_process_restart_snapshot.py` — snapshot stability across
  worker_type forms, Codex null/missing keys, assistant toggle, `pty_mode` vs `visible`
  (lines 27-169).
- `tests/unit/test_agentic_process_restart_info.py` — `_diff_snapshot_fields` +
  `restart_info_action` shape: before-start (loaded None), no-drift, workdir edit, worker
  field edit, non-tracked edit (lines 23-210).
- `ui/tests/long_tests/restart_required.test.ts` — live SDK + WS: per-field flip for every
  tracked field, negative fields don't flip, not-running gate, external set, no-op save,
  two-mutation no-flicker (lines 54-209).

**Slickness:** The *entity-side* contract is slick — mutate + save, the flag manages itself,
`restart()` clears it. The hidden cost is the snapshot's fragility: correctness depends on
every construction path normalizing identically, which is why three dedicated snapshot-stability
tests exist.

---

<a id="recovery"></a>
<a id="resume-gate"></a>
## #recovery — resume after backend restart

A PTY worker is a child of the backend; killing the backend kills the worker. Recovery
re-spawns it with the original session (`claude --resume <session_id>`), preserving scrollback.

**Entity-state root cause (why recovery is needed):** after a restart the DB rows still read
RUNNING (shell.status=running, process.status=running) but the in-memory PTY registry is empty
— the loader sees no error signal, so nothing triggers a resume on its own.

<a id="pty-resume"></a>
<a id="resume-session"></a>
**On-demand `open()` resume** ([#pty-resume](#pty-resume)):

| # | Layer | Call |
|---|-------|------|
| 1 | backend | loader hits `POST /api/v1/graph/agentic_process/{id}/open` |
| 2 | Python | detects the stale PTY (Shell.start alive-check), cleans up |
| 3 | Python | if the JSONL transcript exists → `claude --resume` (`is_resume: True`); else fresh session (`is_resume: False`) |
| 4 | Python | registers an `on_exit` callback so closing the shell moves status → idle |

<a id="pty-recovery"></a>
**No global sweep** ([#pty-recovery](#pty-recovery)): `run_pty_recovery()` must **not** enumerate every AP/Shell and respawn
each dead PTY — that fired hundreds of `openpty()` calls at startup and crash-looped prod with
`OSError: out of pty devices`. Recovery is on-demand: a shell's PTY is revived only when its
process is loaded and found dead. (The *visible, running* AP watchdog path is the one
exception the TS tests exercise below.)

**Reference tests**
- `tests/api/test_agentic_process_resume_after_restart.py` — `open()` reconnects the session,
  registers on_exit, is idempotent when alive (2nd open reuses the worker PID in <1000ms),
  starts fresh without a transcript, preserves `session_id` (lines 115-362).
- `tests/api/test_pty_recovery_on_demand.py` — `run_pty_recovery()` must **not** spawn a PTY
  for an unloaded shell; on-demand `start_pty()` revives exactly one (lines 70-105).
- `ui/tests/long_tests/pty_recovery_after_restart.test.ts` — real kill+restart of an isolated
  instance; every worker type recovers: distinct `on_recovered` event, `os-status`
  worker_alive/attachable, a **fresh** worker PID, and pre-restart scrollback preserved in the
  framed `.pty` replay (lines 68-157).
- `ui/tests/api/agentic_survives_restart.test.ts` — `openTab('claude_code', …)` (visible,
  running) → restart dev-1 via `instance_ctl` → the dead-worker watchdog respawns it,
  asserted via `os-status.worker_alive` (lines 39-110).

**Slickness:** The `open()`-as-resume overload is elegant — one idempotent call is create,
attach, resume, and no-op depending on state, and `is_resume` tells the caller which happened.
The awkwardness lives one layer down: "recover on demand, but *also* a watchdog respawns
visible+running workers" is two overlapping recovery mechanisms a caller must hold in their head.

---

<a id="prompt-queue"></a>
## #prompt-queue — enqueue → drain → worker executes

A FIFO file queue (`prompt_queue.json`) that feeds a worker. The head is consumed exactly
once; the boot path differs by transport.

**Queue primitive** (`PromptQueue`, pure file ops): `enqueue` (FIFO, returns entry with id),
`peek`, `pop` (head first), `dequeue(id | index)`, `clear`, `set_enabled`, `log` + `log_entries`.
Corrupt file → default `{enabled: True, entries: []}` (no raise); writes are atomic (no `.tmp`
leftovers).

**Drain flow:**

| # | Layer | Call |
|---|-------|------|
| 1 | Python | `process.queue.enqueue(prompt, source="ui")` — pure file, no worker yet |
| 2a | Python (PTY) | loader `start_pty()` (no instruction) → `_perform_open` pops the head as the launch arg |
| 2b | Python (headless) | `_maybe_drain_queue("enqueue")` cold-starts the headless worker WITH the head via `headless_prompt` |
| 3 | Python | `async for entry in process.stream_transcript(timeout=28)` drives the turn to completion |
| 4 | Python | queue drained (`entries == []`); log order `enqueue < pop < inject < injected` |

The split is deliberate: the enqueue drain must **not** cold-start a *visible* process — that
would race the dock loader that owns PTY spawn. For headless there is no such loader, so
enqueue drives the cold start itself.

**Reference tests**
- `tests/long_tests/test_prompt_queue_integration.py` — parametrized pty/headless: enqueue a
  queue-of-one, boot the worker, assert the sentinel lands in the transcript, queue drains, and
  the log proves the head was consumed once in order (lines 31-99).
- `tests/unit/test_prompt_queue.py` — the file primitive: FIFO, persistence, dequeue by
  id/index, clear/enabled, corrupt-file recovery, per-action log, atomic write (lines 16-106).

**Slickness:** The queue primitive itself is clean. The drain is where a caller must know
non-obvious rules: which seam to boot through (`start_pty` vs `_maybe_drain_queue`) depends on
`visible`, and the "don't cold-start a visible process from enqueue" invariant is a
loader-ordering constraint the queue API doesn't express. See [Findings](#findings).

---

<a id="plan-inject"></a>
## #plan-inject — execute-plan / update-plan inject into a live PTY

Push a plan (or plan-note update) into a running interactive session by injecting text through
the PTY.

| Action | Body | Injected via `send` |
|--------|------|---------------------|
| `execute-plan` | `{ file_path, clear_context: False }` | one string call carrying `file_path` + a `plan-note` wrapper; `data.injected == True` |
| `execute-plan` | `{ file_path, clear_context: True }` | **two** string calls: `"/clear"` then the plan prompt |
| `update-plan` | `{ file_path }` | one string call carrying `plan-note`; `data.ok == True` |
| any, **no PTY** | — | `send` never called; still `SUCCESS` + `injected: True` (skips silently) |

1. `POST /api/v1/graph/agentic_process/{id}/execute-plan` (or `/update-plan`)
2. Python `inject → send(str)` writes into the PTY session

**Reference tests**
- `tests/api/test_agentic_process_pty_inject.py` — mocks `AgenticProcess.send`, asserts the
  exact string calls: execute-plan single inject, clear_context → `/clear` then plan, update-plan
  single inject, no-PTY skips silently (lines 22-145).
- `tests/api/test_agentic_process_plan_actions.py` — action surface over real files:
  execute-plan success/clear-context/nonexistent/valid, update-plan with/without/multiple
  `<plan-note>` sections and missing file (all return SUCCESS; desktop stub doesn't validate
  files) (lines 39-276).

**Slickness:** Reasonable. Two named actions, small bodies. One quirk worth flagging: a
no-PTY injection returns `injected: True` even though nothing was injected (lines 137-143 of
the inject test) — the success field doesn't distinguish "sent" from "no-op skipped."

---

<a id="fork"></a>
## #fork — fork a session

Branch a session into a sibling process that inherits history. **Browser-only coverage** — no
Python or SDK integration test exists.

**From the process toolbar** (`processtoolbar_fork.md`, Advanced view only):
1. Fork button (GitFork) is **disabled** before the first assistant turn — tooltip
   "Send a message first — fork requires conversation history".
2. After a turn completes (`workerStatus` past IDLE/INITIALIZING) the button enables.
3. Click Fork → tooltip "Forking…" → URL changes to a new `/dock/shell/agentic_process-<id>`.
4. A new sibling tab is added (old tab stays); the new tab's transcript lens shows the prior
   history (fork copies it).

**From the global search dock-menu** (`fork_action_from_search_dock.md`):
1. Fork action (branch icon) on a `claude_session` search result.
2. Creates a new `AgenticProcess` with `workdir == source session cwd`; the `createProcess`
   payload includes `{ visible: true, watchProcess: false }`.
3. The new shell tab mounts an **interactive** xterm (typing `echo hi` prints `hi`).
   Pre-fix failure signature: created `visible: false`, PTY never attaches / blank terminal.

**`conversation_view_three_spawn_branches.md` is stale** — flagged TEST-ISSUE (2026-06-04):
it describes a `ConversationView.tsx` / `taskSessionCache` / `agentic_session_id` trio that no
longer exists. Spawn now lives in `useApproveAndExecute.ts` and `useMyProcess.ts`
(`AgenticProcess.spawn({workdir, projectId}, {instruction, visible})`, Tasks carry
`my_process_id`). Do not treat its four numbered branches as current behavior.

**Slickness:** Can't judge the API from tests — there is none below the browser. The two live
scenarios show two different fork entry points (toolbar GitFork vs search branch icon) producing
similarly-shaped results; the search path's `{ visible: true, watchProcess: false }` payload is
the only concrete API contract captured, and only as a DevTools assertion. See [Findings](#findings).

---

<a id="shell-tabs"></a>
<a id="run-command"></a>
## #shell-tabs — plain shell tab lifecycle

The terminal-tab CRUD layer, independent of any agentic worker. See [shell](./shell.md).

<a id="shell-open"></a>
**Shell open** ([#shell-open](#shell-open)): a tab is opened either by starting a PTY session
(`terminal-command/start`, which also writes the `ShellRecord`) or by creating a bare entity
(`POST /graph/shell`). The PTY-start form is the one that produces a live terminal;
[#pty-start](#pty-start) is the worker-bearing sibling of this bare-shell open.

<a id="shell-close"></a>
**Shell close** ([#shell-close](#shell-close)): `terminal-command/close` (single, PTY-registry
disk write) or the batched `tabs/close` (typeid targets, also hides+stops AP tabs). Both delete
the disk record and the DB entity, so a closed shell drops out of `list-shells`.

**TS (record write-through)** — `ui/tests/api/shell_tabs.test.ts`:
1. `POST …/compute_node/{cn}/terminal-command/start` `{ shell_id: <uuid>, connection_id, rows, cols }`
   creates a `ShellRecord` with `state=running` ([#shell-open](#shell-open)).
2. `GET …/compute_node/{cn}/list-shells` returns active (non-closed) sessions.
3. `POST …/compute_node/{cn}/terminal-command/close` `{ shell_id }` — `Shell.close()` deletes
   both the disk record and the DB entity ([#shell-close](#shell-close)); the session is no
   longer discoverable, and list-shells excludes it (the "close all → refresh → tabs back" bug
   scenario, lines 92-155).

**Python (entity CRUD)** — `tests/api/test_shell_lifecycle.py`:
- create / read / close (close deletes the entity, lines 13-83)
- rename via canonical `PUT /graph/shell/{id}` (`name`, `auto_rename`, `tab_order`; `auto_rename`
  defaults True, lines 85-107)
- `list-shells` includes created, excludes closed, empty after close-all (lines 110-193)
- `POST …/compute_node/@local/tabs/close` `{ targets: ["shell-<id>", …] }` — batched teardown
  returning `{ accepted, missing, invalid }`; an AP target is hidden (`visible=False`) and
  torn down (status → stopping/stopped) (lines 197-250)
- `run` (`{ command }` → `{ stdout, exit_code }`) and `set-env` (`{ vars }` → persisted `env`)
  (lines 277-327)

**Slickness:** Two teardown verbs exist for what a caller might see as one intent:
`terminal-command/close` (single, PTY-registry disk write) and `tabs/close` (batched typeid
targets, also hides+stops AP tabs). Creation likewise splits `terminal-command/start` (PTY +
record) from `POST /graph/shell` (bare entity). Functional but not a single obvious surface.

---

## Status derivations (referenced by [status-model](./status-model.md))

These are not flows but the shared status projections the flows above depend on. They live here
so [status-model](./status-model.md) can link a single canonical description; that doc owns the
full worker-status state machine.

<a id="ready-for-input"></a>
### #ready-for-input — can a caller send a prompt?

`is_ready_for_input(process, worker_status=None)`
(`flow_sdk/builtin/agentic_process/status_predicates.py:72`) is the gate every send/enqueue path
consults. Contract (truth-tabled in both the pytest and vitest suites):

```
is_ready_for_input(p)  ⇔  p.status == RUNNING  AND  worker_status ∈ {IDLE, COMPLETE, INTERRUPTED}
```

Special case: `worker_status is None` means the transcript hasn't been discovered yet — a RUNNING
process with no derivable status is *spawned-and-idle* (ready for its first prompt) unless a turn
is genuinely in flight (`_turn_in_flight`, set by the headless drivers for a turn's duration). The
optional `worker_status` arg lets a hot path (e.g. a serializer) pass an already-resolved value and
avoid a second transcript tail-read. This predicate powers [#prompt-queue](#prompt-queue)'s
readiness check (`test_prompt_queue_integration.py:70` asserts `is_ready_for_input(process) is True`
after the injected turn) and [#headless-execute](#headless-execute)'s turn boundaries.

**Which FE surface consumes it** (B1, verified 2026-07-02): `isReadyForInput` is consumed by
`process-status-line.tsx` (`:110`), which enables/disables the inline status affordance. It is **not**
what gates the chat input box — the composer (`ChatComposerBar.tsx:83`) gates on
`isWorkerRunning(workerStatus)` (busy while the worker is mid-turn), a coarser worker-running check.
Don't conflate the two: a process can be `!isWorkerRunning` yet `!isReadyForInput` (e.g. not RUNNING),
so the composer and the status line disable on different conditions.

<a id="worker-status-serialize"></a>
### #worker-status-serialize — stored vs computed status on the wire

Worker status is **computed, not stored** — it's derived from the transcript tail and stamped onto
every serialized payload. There is exactly one live seam, in
`flow_sdk/builtin/agentic_process/agentic_process.py`:

- `api_json_serializer()` (the `model_serializer(mode="wrap")`, ~line 3739) calls
  `fetch_worker_status()` (delegating to `_discover_status_from_transcript`), then sets
  `data["worker_status"] = str(computed) or IDLE`,
  `data["ready_for_input"] = is_ready_for_input(self, computed)`, plus `queue` and
  `supports_plan_mode`. (An earlier `to_dict()` override that looked like a second seam was dead code
  — its `super().to_dict()` raised `AttributeError`, no caller invoked it — and was removed
  2026-07-02.)
- Deliberately **not** computed in the serializer: `cmd_line` — resolving it walks
  `cli_options → transcript_descriptor → get_claude_session`, i.e. live disk I/O, which must never
  run inside a `model_dump()` (the currency for persistence, query filters, WS broadcast, and REST
  responses). The launch command is fetched on demand via the separate `cmd-line` action.

So the field a client reads as `worker_status` is a projection re-run on every serialization, and
the `IDLE` fallback is what an undiscovered-transcript process serializes as. See
[status-model](./status-model.md) for the projection rules themselves.

<a id="execution-mode-chip"></a>
### #execution-mode-chip — how the footer chip is classified

`classify_execution_mode(*, status, worker_status, visible, pid_alive=None)`
(`flow_sdk/builtin/worker_status.py:119`) drives the footer execution-mode chip, mirroring the TS
`classifyExecutionMode` truth table:

1. process not in a live status → `None` (no chip)
2. `worker_status` in the error set → `ERROR`
3. `visible=True` and `pid_alive=False` (dead PTY) → `ERROR`
4. `visible=True` → `INTERACTIVE`
5. `visible=False` → `BACKGROUND`

`EXTERNAL` is never returned here; `pid_alive` only matters for PTY (CLI workers have no PID, so
rule 3 never fires for them). It's consumed by `flow_sdk/app/actions/workers.py:66`. Note this is
the same `visible` split that routes [#prompt-streaming](#prompt-streaming) and
[#mode-switch](#mode-switch) — the chip is a read-only view of that transport intent.

## Findings

### Non-slick flows

1. **Fork has no callable API contract — only browser assertions.** Every other flow here can
   be driven from Python or the TS SDK; fork can only be observed through the UI
   (`processtoolbar_fork.md`, `fork_action_from_search_dock.md`), and its one concrete
   contract — the `createProcess` body `{ visible: true, watchProcess: false }` with
   `workdir == source cwd` — is captured as a DevTools Network assertion, not a test a CI run
   executes. A caller wanting to fork programmatically has to reverse-engineer it from
   `useMyProcess.ts`/`useApproveAndExecute.ts`, and the one scenario that *did* describe the
   spawn logic is stale (`conversation_view_three_spawn_branches.md`).

2. **The mode toggle is asymmetric — one direction is `switch-mode`, the other is `open`.**
   `switchMode(WorkerMode.CLI)` calls the `switch-mode` action, but
   `switchMode(WorkerMode.Interactive)` does **not** — it routes through `start()` → the `open`
   action and then must `emit('restarted')` client-side so the terminal re-attaches
   (`agentic-process-switch-mode.test.ts:68-85`; backend `test_agentic_process_switch_mode.py:66-79`
   confirms interactive dispatches to `_perform_open`, not a symmetric branch of `switch_mode`).
   A slick toggle would be one action with a `mode` argument owning both transitions and the
   re-attach signal; today the caller must know the two halves live in different places.

3. **Reaching each transport requires the caller to know the `visible` × `pty_mode` matrix.**
   `visible=False` alone yields the PTY transcript stream, not print-mode framing — you must
   *also* set `pty_mode=False` to get the `flow-status`/`flow-chat`/`flow-end` frames
   (`test_agentic_process_prompt_streaming.py:73-97` spells this out in a comment because it is
   non-obvious). Two flags with overlapping-but-not-identical meaning gate which of two output
   shapes you get; a slick API would expose one intent ("headless print" vs "interactive PTY")
   and derive both flags internally.

Honorable mentions: the **prompt-queue drain** forces the caller to know that visible processes
boot through the dock loader's `start_pty` while headless boot through `_maybe_drain_queue`, and
that enqueue must *not* cold-start a visible process (a loader-ordering invariant the queue API
can't express, `test_prompt_queue_integration.py:53-66`). The **bottom-up PTY attach** is three
different actions (`upsertSessionProcess`, `terminals/get_by_worker_id`, `findSession`) rather
than the single "raw PTY → elevate → process" the task framing implies. **Shell teardown** has
two verbs (`terminal-command/close` vs `tabs/close`) and creation has two (`terminal-command/start`
vs `POST /graph/shell`).

### Coverage gaps

- **No live E2E for headless → interactive → headless with real PTY re-attach.** `#mode-switch`
  is covered only at unit level (both `test_agentic_process_switch_mode.py` and
  `agentic-process-switch-mode.test.ts` mock `_perform_open`/`callAction`). Nothing drives a real
  round-trip that spawns a PTY, switches to CLI, switches back, and verifies the terminal
  actually re-attaches to a live worker.
- **`set-visible` has no dedicated Python API test.** Visibility flips are asserted only as
  side-effects — `tabs/close` setting `visible=False` (`test_shell_lifecycle.py:246-250`) and
  `restart_required` *not* tracking `visible` (`restart_required.test.ts:85`). There is no test
  that sets visibility directly and asserts the transport/tab consequence.
- **Fork has no Python/SDK integration test** (browser-only, per above). The
  `visible: true` create-payload contract (the exact bug the search-dock scenario guards) is
  never exercised by an automated run.
- **`tests/api/test_agentic_process_execute.py` is an empty file (0 bytes).** The headless
  execute path has TS long-test coverage (`agentic_process_execute.test.ts`) but **zero** Python
  API coverage despite the file existing as a placeholder.
- **`findSession`/`get_by_worker_id` for Codex are gated on the `codex` binary**
  (`requires_codex`, `test_pty_process_e2e.py:22-25`), so the Codex discovery+upsert path is
  skipped on any host without the optional CLI — Claude is the only always-exercised sibling.
- **`recovery` mixes on-demand `open()` resume with a visible-AP watchdog**, but no single test
  proves the two don't double-spawn (one revives on load, one revives on a ~5s watchdog tick);
  `test_pty_recovery_on_demand.py` proves the *global* sweep is gone, and the TS tests prove the
  watchdog works, but their interaction is untested.
