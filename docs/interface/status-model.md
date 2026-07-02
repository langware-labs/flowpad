# Status model — interface

Interface reference for the process/worker status model, backend↔frontend paired. This is the two-axis `(ProcessStatus, WorkerStatus)` model plus its derived projections (`WorkerMode`, `ExecutionMode`, `ready_for_input`). For the narrative on why the two axes exist and how PTY/headless routing works, see [agentic-process.md](../agent-management/agentic-process.md).

The two axes:

- **`ProcessStatus`** — app/user-level lifecycle of the process *container*. Backend-owned FSM, **stored**, explicit transitions (`NEW → STARTING → RUNNING → STOPPING → STOPPED`, `any → FAILED`).
- **`WorkerStatus`** — expert-level state of the worker (Claude session) running *inside* the process. **Derived** from the JSONL transcript tail on every serialize; never stored. Only meaningful when `ProcessStatus ∈ {RUNNING, STOPPING, STOPPED}`; treat as undefined otherwise.

## Python objects & API

### Enums

| Enum | File | Values |
| --- | --- | --- |
| `ProcessStatus(StrEnum)` | `flow_sdk/builtin/process_lifecycle.py` | `new`, `starting`, `running`, `stopping`, `stopped`, `failed` |
| `WorkerStatus(StrEnum)` | `flow_sdk/builtin/worker_status.py` | `initializing`, `idle`, `complete`, `error`, `interrupted`, `inactive`, `pending_user`, `working`, `thinking`, `tool_call`, `tool_running`, `api_error`, `api_timeout`, `unknown` |
| `WorkerMode(StrEnum)` | `flow_sdk/builtin/agentic_process/status_predicates.py` (~:43) | `interactive`, `cli` |
| `ExecutionMode(StrEnum)` | `flow_sdk/builtin/worker_status.py` (~:106) | `interactive`, `background`, `error`, `external` |

`WorkerStatus` values group into four semantic buckets: **pre-turn** (`initializing`, `idle`), **active/mid-turn** (`working`, `thinking`, `tool_call`, `tool_running`, `api_error`), **terminal** (`complete`, `error`, `interrupted`, `inactive`, `api_timeout`), and **projections/fallback** (`pending_user`, `unknown`). `unknown` is a deliberate parse fallback (surfaces new/malformed Claude event types) rather than a silent "running" catch-all.

### Helper sets & predicates

All in `flow_sdk/builtin/worker_status.py` unless noted. The frozensets are kept **byte-for-byte identical** to their TS counterparts, enforced by a contract test against `test_fixtures/status_sets.json`.

| Predicate | Set | Members |
| --- | --- | --- |
| `is_running(status)` | `_RUNNING_STATUSES` | `working`, `thinking`, `tool_call`, `tool_running`, `api_error` |
| `is_busy(status)` | `_BUSY_STATUSES` | `thinking`, `tool_call`, `tool_running` (excludes `working`/`api_error`) |
| `is_idle(status)` | inverse of `_RUNNING_STATUSES` | — |
| `is_terminal(status)` | `_TERMINAL_STATUSES` | `complete`, `error`, `interrupted`, `inactive`, `api_timeout` |
| (`classify_execution_mode` error gate) | `_ERROR_STATUSES` | `error`, `api_timeout`, `inactive` |
| `is_ready_for_input(process, worker_status=None)` | `_READY_WORKER_STATES` (status_predicates.py ~:65) | `idle`, `complete`, `interrupted` |

- **`classify_execution_mode(*, status, worker_status, visible, pid_alive=None)`** (~:119) — classifies a *live* worker into an `ExecutionMode`, or `None` if the process isn't live (`status ∉ {running, starting}`). Truth table (first match wins): `worker_status ∈ _ERROR_STATUSES` → `ERROR`; `visible and not pid_alive` (dead PTY) → `ERROR`; `visible` → `INTERACTIVE`; else → `BACKGROUND`. `EXTERNAL` is never returned here (OS-scan only).
- **`get_worker_mode(process)`** (status_predicates.py ~:60) — `INTERACTIVE` if `process.visible` else `CLI`.
- **`is_ready_for_input(process, worker_status=None)`** (status_predicates.py ~:72) — the single canonical "can the caller send a new prompt?" gate: `status == RUNNING AND worker_status ∈ {idle, complete, interrupted}`. When `worker_status is None` (transcript not yet discovered) it falls back to `not _turn_in_flight`. Pass a pre-resolved `worker_status` to avoid a second tail-read.
- **`ApiErrorTimeoutError(TimeoutError)`** (~:394) — raised by `stream_transcript` when it times out *while the process is in `API_ERROR`*, i.e. the Anthropic API returned repeated errors (e.g. 529) and Claude was still retrying. Infra issue, not a logic failure — tests should skip, not fail.

### `_tail_status` — the deriving function

`_tail_status(path)` (`worker_status.py` ~:451) is the transcript→`WorkerStatus` classifier: mtime-liveness check, expanding tail read (4 KB, widening ×16 up to `_TAIL_MAX_BYTES = 2 MiB` when the window is all content-free envelope lines), then classify with terminal signals taking priority. It returns any value **except** `idle`/`pending_user`: `idle` comes from a `system:init` tail (worker booted, awaiting first turn) or is set externally as the workflow default; `pending_user` is a backend projection (below), not a transcript signal. Fallback is `unknown`, never `running`.

### Computed vs stored — how the values reach the wire

Three distinct fields, only the first is stored:

| Field | Stored? | Who computes | Where |
| --- | --- | --- | --- |
| `status` | **yes** | explicit FSM transitions | `agentic_process.py` writers |
| `worker_status` | no (computed each serialize) | `fetch_worker_status()` → `_discover_status_from_transcript()` → driver tail | `agentic_process.py:3776` / injected in `to_dict` (`:3726`) + `api_json_serializer` (`:3741`) |
| `ready_for_input` | no (computed each serialize) | `is_ready_for_input(self, computed)` | `agentic_process.py:3728` / `:3743` |

`fetch_worker_status()` is the supported accessor; `_discover_status_from_transcript()` is the internal projection (tests monkeypatch it). The projection layer does more than `_tail_status`: it short-circuits to `INITIALIZING` while `_turn_in_flight`, reconciles dead PTYs (`pty_mode` + dead shell pid → `INACTIVE`), and **projects clean terminals to `PENDING_USER`** (recent) or `INACTIVE` (aged > 5 min via `terminal_at`) so every consumer — serializer, `get_status`, `is_ready_for_input` — sees the same projected value.

The **status report** (token/message/tool-call counters + focused asset) is a separate projection: `ProcessCounters` / `ProcessStatusReport` in `flow_sdk/transcript_analyzer/counters.py`, pushed on the `progress_report` FlowData envelope (`attributes.kind == PROCESS_STATUS_KIND == "process_status"`) and persisted on the `status_report` field.

## Backend↔frontend pairing

One row per concept. TS symbols live in `ts_sdk/src/process/agentic-types.ts` unless noted. **Enum values verified byte-identical** across all four enums.

| Concept | Backend symbol (file) | TS symbol (file) | Drift notes |
| --- | --- | --- | --- |
| Process lifecycle enum | `ProcessStatus` (`process_lifecycle.py`) | `ProcessStatus` (`agentic-types.ts:31`) | values ✓ (6/6) |
| Worker status enum | `WorkerStatus` (`worker_status.py`) | `WorkerStatus` (`agentic-types.ts:73`) | values ✓ (14/14). TS docstring cites stale path `flow_sdk/fs_records/agent_status.py` (actual: `flow_sdk/builtin/worker_status.py`) |
| Worker mode enum | `WorkerMode` (`status_predicates.py:43`) | `WorkerMode` (`agentic-types.ts:202`) | values ✓ (`interactive`/`cli`). TS key casing `Interactive`/`CLI`, values match |
| Execution mode enum | `ExecutionMode` (`worker_status.py:106`) | `ExecutionMode` (`agentic-types.ts:259`) | values ✓ (4/4) |
| Model tier enum | `ModelTier` (`agentic_process/model_tiers.py`) | `WorkerModelTier` (`agentic-types.ts:217`) | values `sm`/`md`/`lg`; TS is authoritative wire form, must stay in lockstep |
| Process running | `is_running` (`process_lifecycle.py:40`) | `isProcessRunning` (`:53`); `isProcessActive` deprecated alias (`:58`) | set `{starting, running, stopping}` ✓ |
| Process startable | `is_startable` (`process_lifecycle.py:45`) | `isProcessStartable` (`:61`) | set `{new, stopped, failed}` ✓ |
| Worker running (mid-turn) | `is_running` / `_RUNNING_STATUSES` (`worker_status.py:146`) | `isWorkerRunning` / `WORKER_RUNNING_STATUSES` (`:159`) | byte-identical via `status_sets.json` ✓ |
| Worker terminal | `is_terminal` / `_TERMINAL_STATUSES` (`:161`) | `isWorkerTerminal` / `WORKER_TERMINAL_STATUSES` (`:164`) | byte-identical ✓ |
| Error-execution states | `_ERROR_STATUSES` (`:95`) | `ERROR_WORKER_STATUSES` (`:278`) | byte-identical (`error`, `api_timeout`, `inactive`) via fixture key `worker_execution_error` ✓ |
| Ready for input | `is_ready_for_input` / `_READY_WORKER_STATES` (`status_predicates.py:72`) | `isReadyForInput` / `READY_WORKER_STATUSES` (`:353`) | contract `status==RUNNING AND worker∈{idle,complete,interrupted}` ✓ |
| Derive worker mode | `get_worker_mode` (`status_predicates.py:60`) | `getWorkerMode` (`:245`) | both derive from `visible` — **display projection only, see caution** |
| Classify execution mode | `classify_execution_mode` (`worker_status.py:119`) | `classifyExecutionMode` (`:322`) | truth tables match; both key on `visible`+`pid_alive` — **see caution** |
| "Can't accept input" | `is_busy(status)` — **worker-status arg** (`worker_status.py:151`) | `isBusy(process)` — `!isReadyForInput` (`:368`) | **NAME COLLISION, divergent semantics.** BE `is_busy` = `status ∈ {thinking, tool_call, tool_running}`; TS `isBusy` = negation of `isReadyForInput` over a whole process. Not a pair — do not treat as equivalent |
| Awaiting user input | *(no direct BE predicate; `_queue_ready` at `agentic_process.py:1619` is the drain-local superset)* | `isAwaitingUserInput` / `AWAITING_USER_INPUT_STATUSES` (`:146`,`:154`) | TS-only. `READY ∪ {pending_user}`; gates the chat⇄terminal toggle (mid-turn switch is 409'd) |
| Has worker started | *(none)* | `hasWorkerStarted` (`:173`) | TS-only; `status !== initializing` |
| Display status pick | *(none)* | `getDisplayStatus` (`:380`) | TS-only; running→`workerStatus` (unless `unknown`), else coarse `status` |
| Supported exec modes per view | *(none)* | `supportedExecutionModes` (`:300`) | TS-only; Standard hides `error`/`external` |
| `ready_for_input` field | `is_ready_for_input` injected in serializers (`agentic_process.py:3728`,`:3743`) | consumed off the wire via `StatusBearingProcess` | computed each serialize, not stored |
| Status report / counters | `ProcessCounters`, `ProcessStatusReport`, `PROCESS_STATUS_KIND` (`transcript_analyzer/counters.py`) | `ProcessCounters`, `ProcessStatusReport`, `parseStatusReport`, `PROCESS_STATUS_KIND` (`process-status-report.ts`) | wire kind `"process_status"` ✓; `ProcessCounters` is a class both sides for the "extend later" seam |

## Frontend TS interface

`ts_sdk/src/process/agentic-types.ts`:

- **Enums** — `ProcessStatus`, `WorkerStatus`, `WorkerMode`, `WorkerModelTier`, `ExecutionMode` (values verified against backend above).
- **Sets (module-private)** — `RUNNING_PROCESS_STATUSES`, `STARTABLE_PROCESS_STATUSES`, `WORKER_RUNNING_STATUSES`, `WORKER_TERMINAL_STATUSES`, `READY_WORKER_STATUSES`, `AWAITING_USER_INPUT_STATUSES`; exported const `ERROR_WORKER_STATUSES`.
- **Predicates** — `isProcessRunning`, `isProcessStartable`, `isWorkerRunning`, `isWorkerTerminal`, `hasWorkerStarted`, `isAwaitingUserInput`, `isReadyForInput`, `isBusy`, `getWorkerMode`, `classifyExecutionMode`, `getDisplayStatus`, `supportedExecutionModes`. Deprecated alias `isProcessActive`.
- **`StatusBearingProcess`** (`:181`) — the minimal duck-typed shape most predicates accept (`status`, `workerStatus`/`worker_status`, `session_id`, `visible`), decoupled from the full `AgenticProcess`. `resolveStatus`/`resolveWorkerStatus` read either camel or snake field.
- **`ProcessIconKey`** (`:234`) — vendor×state icon contract (`claude`/`codex`/`copilot`/`generic` × `-restore`), resolved to a React icon by `ui/src/components/icons/process-icons.ts`.

`ts_sdk/src/process/process-status-report.ts`: `ProcessCountersData` (wire shape), `ProcessCounters` (class with `totalTokens`/`formatted()`), `FocusedAsset`, `ProcessStatusReport`, `parseStatusReport(raw)` (null on absent/garbage), and the `PROCESS_STATUS_KIND` const.

## ⚠️ Known debt — `visible` vs `pty_mode` (arch-review CONFIRMED)

In the two-axis transport model, **`visible`** (is a tab shown for this worker?) and **`pty_mode`** (is the transport a PTY?) are independent. Two derivations still collapse them:

- **`get_worker_mode`** (`status_predicates.py` ~:60) and **`classify_execution_mode`** (`worker_status.py` ~:114/119) derive the worker's mode from **`visible`**, not `pty_mode`. In the two-axis model this is **stale**: these are **display projections only** (footer chip grouping, mode label). **Routing / transport code must key on `pty_mode`, never on these.** A hidden-but-PTY worker (`visible=false`, `pty_mode=true`) still has a live PTY worker that can die — which is exactly why `_discover_status_from_transcript`'s dead-PTY reconciliation keys on `pty_mode`, not `visible`.
- The **`WorkerMode` docstring** at `status_predicates.py` ~:46 asserting "headless == `!visible`" is **stale** for the same reason. `CLI`/`INTERACTIVE` here mean "no tab shown" / "tab shown", not the underlying transport.

Also note the two **stale path references** in the TS/Python docstrings pointing at `flow_sdk/fs_records/agent_status.py` — the enum's real home is `flow_sdk/builtin/worker_status.py`.

## Flows

Short pointers into [flows.md](./flows.md) (sibling doc):

- Send-a-prompt gate — `isReadyForInput` / `is_ready_for_input`: see [flows.md#ready-for-input](./flows.md#ready-for-input).
- Chat⇄terminal toggle gate — `AWAITING_USER_INPUT_STATUSES` (mid-turn switch → 409): see [flows.md#mode-switch](./flows.md#mode-switch).
- Worker-status derivation on serialize — `_tail_status` → projection → wire: see [flows.md#worker-status-serialize](./flows.md#worker-status-serialize).
- Footer worker-list chip grouping — `classifyExecutionMode` / `supportedExecutionModes`: see [flows.md#execution-mode-chip](./flows.md#execution-mode-chip).
