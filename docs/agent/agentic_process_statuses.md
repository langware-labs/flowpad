# AgenticProcess statuses — the canonical model

This is the single authoritative reference for how an AgenticProcess's status is
represented, derived, and consumed. It supersedes the scattered status sections
in `docs/interface/` and `docs/agent-management/` where they disagree.

The model has **three axes**, each answering a different question:

| Axis | Question | Stored? | Where |
|---|---|---|---|
| **worker_status** | "what we found" — the raw worker state, in worker lingo | No (derived per serialize) | `flow_sdk/builtin/worker_status.py` |
| **process status** | "what it means" — the logical, vendor-agnostic status | The FSM is stored; `ready`/`busy` are wire-only projections | `flow_sdk/builtin/process_lifecycle.py` + `status_predicates.py` |
| **os_status** | "is the OS process actually alive?" — PTY/worker liveness | No (probed on demand) | `agentic_process.py` `os-status` action + `server/pty_recovery.py` |

All status LOGIC is backend-side. The frontend is read-only for status: it reads
the serialized `status` / `worker_status` fields and renders them. It never
re-derives status (the one exception, `useDerivedWorkerStatus`, was removed — see
"Frontend" below).

---

## 1. worker_status — "what we found"

`WorkerStatus` (`flow_sdk/builtin/worker_status.py`) is the **union of the raw,
granular states the worker vendors can evidence in their transcripts**, in worker
lingo. 14 values:

```
initializing  idle  complete  error  interrupted  inactive  pending_user
working  thinking  tool_call  tool_running  api_error  api_timeout  unknown
```

- Derived on every serialize from the vendor transcript tail: `_tail_status`
  (claude) and the per-vendor `cli_drivers/{codex,copilot}/status.py` maps.
  Never stored.
- **Nullable on the wire.** When there is no transcript to read, `worker_status`
  is `null` ("nothing found") — it is never coerced to a placeholder.
- **No projection.** `_discover_status_from_transcript`
  (`agentic_process.py`) returns the raw tail value with exactly one
  transcript-consistency reconciliation (`_post_tool_idle_complete → complete`).
  It does NOT synthesize `pending_user`/`inactive`/`initializing` — those are
  returned by `_tail_status` directly when the transcript actually shows them.

WorkerStatus is used for the fine-grained activity indicator (Thinking / Using
tool / …). It is **never** used to gate input or the pty-mode switch — that is the
process status's job.

## 2. process status — "what it means"

`ProcessStatus` (`flow_sdk/builtin/process_lifecycle.py`) is the logical status,
identical across every worker vendor. It has two forms:

- **Stored FSM** (control plane): `new → starting → running → stopping → stopped`,
  `any → failed`. Written at explicit lifecycle seams (`_perform_open`,
  `exit()`/`close()`, `_on_pty_exit`, `pty_recovery`).
- **Wire projection**: the serializer never emits the stored `running`. It
  projects it to one of two **logical** values via
  `status_predicates.wire_status`:
  - **`ready`** — the worker can take the next user prompt (¬busy).
  - **`busy`** — a turn is in flight; the user must wait.

  The wire therefore carries `new / starting / ready / busy / stopping / stopped /
  failed`. `ready`/`busy` are **never persisted**; `wire_status` is the only place
  stored `running` becomes them.

Why project instead of store `ready`/`busy`? Busy flips at sub-second granularity
during a turn — storing it would mean a `save()` per flip and write races with the
cross-thread `_on_pty_exit`. Projecting keeps on-disk rows byte-stable (zero
migration), keeps DB query filters on `running` working, and derives `ready`/`busy`
in the same serializer seam as `worker_status` so they can never disagree.

## 3. busy — the one boolean

`busy` is a **function of process state**, computed by
`status_predicates.is_turn_busy(process, worker_status)`. It ORs three signals
(any one → busy):

1. the per-process prompt lock is held (a headless or chat-over-PTY turn), OR
2. `_turn_in_flight` is set (a worker spinning up before its transcript lands), OR
3. the raw `worker_status` is a mid-turn activity state — `_BUSY_WORKER_STATUSES`
   = `{initializing, working, thinking, tool_call, tool_running}`.

A **native xterm turn holds no lock and sets no `_turn_in_flight` flag**, so (3)
is what keeps it busy. That is why the `switch-mode` 409 must key on this predicate
and not on the lock alone.

`is_turn_busy` is the single source consumed by:
- the wire `status` projection (`busy` ⇔ `is_turn_busy`, else `ready`),
- the `switch-mode` / `restart` 409 guard (`_reject_if_turn_in_flight`),
- `ready_for_input` (kept for wire compat; `⇔ wire_status == ready`),
- and, via the serialized `status`, every frontend gate: `isBusy(p) ⇔ p.status ===
  'busy'`, `isReadyForInput(p) ⇔ p.status === 'ready'`.

`ready` and `busy` are disjoint, so the frontend toggle (enabled on `ready`) can
never land on the backend's busy 409.

### worker → wire mapping (when the stored status is `running`)

| raw worker_status | wire process status | rationale |
|---|---|---|
| (lock held) or `_turn_in_flight` — any worker value | **busy** | turn admission is authoritative |
| `initializing` `working` `thinking` `tool_call` `tool_running` | **busy** | mid-turn |
| `null` (nothing found, no turn) | **ready** | spawned-and-never-prompted |
| `idle` | **ready** | at the prompt |
| `pending_user` | **ready** | the worker asked; the user CAN respond |
| `complete` `interrupted` | **ready** | turn over |
| `error` `api_error` `api_timeout` `inactive` `unknown` | **ready** (fail-open) | re-promptable — a parse drift or a transient error must never lock the composer; the exact error still shows via the raw `worker_status` label + the ExecutionMode chip |

Non-running stored statuses (`new/starting/stopping/stopped/failed`) pass through
unchanged.

## 4. os_status — OS-level liveness (the third axis)

Worker/process status are transcript- and lifecycle-derived. Neither answers "is
the OS process actually alive right now?" — that is `os_status`:

- **`os-status` action** (`agentic_process.py`) + **`os-status-batch`**
  (`faas/compute_node.py`) return a per-process snapshot: `pty_alive`,
  `worker_alive`, `has_attachable_pty`, `pid`, and a headline `ready` (PTY alive
  AND the worker PID matches the recorded session). Read-only; no lifecycle
  side-effects.
- **Consumers**: the backend watchdog `server/pty_recovery.py`
  (`run_pty_recovery`) respawns a *watched* dead PTY through `start_pty`;
  `_on_pty_exit` stamps `FAILED` on an observed exit; `reconcile_orphaned_workers`
  stamps dead *headless* workers `STOPPED` at boot.

**Dead-PTY handling has no status projection.** The old worker-status → `INACTIVE`
projection (and the `pending_user_to_inactive` heartbeat that re-broadcast it) were
removed. A watched dead PTY is respawned by the watchdog within a tick; the footer
ExecutionMode chip keys on `pid_alive` independently, so a dead PTY still reads as
an error there. If a genuinely dead PTY is briefly shown as `ready`, typing into it
relaunches it via `--resume` (the prompt path), so it fails safe.

## 5. Broadcast seams

`_flush_transcript_change` (`agentic_process.py`) runs after a debounce on any
transcript change (PTY **and** headless — the FSOp streamer watches both). It:

1. recomputes the raw `worker_status` (`fetch_worker_status`),
2. computes the wire status (`wire_status`),
3. broadcasts (`notify_updated`) only when the **pair** `(wire_status,
   worker_status)` changes.

The **pair key** is load-bearing: a `busy ⇄ ready` flip with an unchanged worker
status (e.g. the prompt lock releases before the JSONL tail moves — the normal
headless turn-start/turn-end edge) still broadcasts, and a raw worker move
(`thinking → tool_call`) within a still-`busy` turn also broadcasts so the mid-turn
indicator advances. The prompt queue drains on the `busy → ready` wire edge.

Removing the old `_turn_in_flight → INITIALIZING` short-circuit is what unblocked
headless mid-turn broadcasts: it used to pin the status all turn, so every flush was
a no-op and `notify_updated` never fired.

## 6. Frontend (read-only)

- `ts_sdk/src/process/agentic-types.ts` mirrors the enums and exposes the single
  gate: `isBusy(p) ⇔ status === 'busy'`, `isReadyForInput(p) ⇔ status === 'ready'`.
  There is no worker-status-derived gating.
- `useDerivedWorkerStatus` was **deleted** — it existed only because headless turns
  didn't broadcast mid-turn; now they do, so every surface reads the reactive
  entity.
- Labels come from ONE shared table, `ts_sdk/src/process/status-labels.ts`
  (`WORKER_STATUS_LABEL` / `PROCESS_STATUS_LABEL`); the status indicator and the
  footer chip both import it (no drift).
- The "your turn" glow (`ui/src/store/pending-actions-store.ts`) arms on the
  `busy → ready` transition (client-side, 300s window) — the replacement for the
  removed backend `PENDING_USER` grace projection.

## 7. Contract fixture

`test_fixtures/status_sets.json` is the byte-for-byte Python↔TS parity source. Keys:

- `worker_running`, `worker_busy` (= `_BUSY_WORKER_STATUSES` / `WORKER_BUSY_STATUSES`),
  `worker_terminal`, `worker_execution_error`,
- `process_stored_running` (the FSM live values), `process_running_wire` (what
  `is_running` / `isProcessRunning` accept — stored `running` + `ready`/`busy` +
  bookends), `process_startable`.

Python contract tests: `tests/unit/test_agentic_process_status.py`. TS:
`ui/tests/unit/agentic-status.test.ts`.
