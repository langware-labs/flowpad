---
id: 2aa28fd4-4cb7-59c8-b554-dbd96bb5acdb
---

# Test coverage — the agentic-process stack, per area × per front

Audited 2026-07-02 against the interface surfaces in this folder. Each cell was
confirmed by opening the test, not by grep alone. **2026-07-02 expansion**: a
coverage push added the Phase-1 pinning tests (A1–A7) and six interface suites
(B1–B6); cells they now cover are flipped below and the new file names are
named. See the [2026-07-02 expansion note](#2026-07-02-expansion) at the end for
what remains deliberately uncovered.

**Fronts:** **U** = pytest unit (`tests/unit/`) · **A** = pytest api
(`tests/api/`, live backend) · **V** = vitest (`ui/tests/api/`,
`ui/tests/unit/`, `ts_sdk` suites) · **R** = react app (`ui/tests/react/`,
`ui/src/test/`, `ui/tests/headless/`).
**Long tests** (`tests/long_tests/`, `ui/tests/long_tests/` — real CLI/PTY
execution) count as real coverage and are marked `✅L`; remember they are
DEEP_TESTING-gated, so `✅L`-only rows have no fast-suite signal.

Legend: ✅ direct fast test (file named) · ✅L direct long test · ◐ indirect /
side-effect · ❌ none.

---

## AgenticProcess ([interface](./agentic-process.md))

| Action(s) | U | A | V | R |
| --- | --- | --- | --- | --- |
| `exit` | ✅ test_process_lifecycle | ✅ test_pty_process_e2e | ◐ via restart suites | ◐ shell_stress |
| `switch-mode` | ✅ test_agentic_process_switch_mode (transitions) | ✅ test_agentic_process_mid_turn_guard (mid-turn 409) | ✅L chat_terminal_switch_stress | ❌ |
| `restart` | ✅ restart_snapshot, pty_session_survives_restart | ✅ pty_recovery_on_demand, resume_after_restart, mid_turn_guard (409) | ✅ agentic_survives_restart, pty_survives_restart | ◐ shell_stress, CommandStatusViewer |
| `self-restart` | ❌ | ✅ test_agentic_process_actions (schedules + emits `worker.restarted`) | ❌ | ❌ |
| `recover-project` | ❌ | ✅ test_project_recovery | ❌ | ❌ |
| `fork` | ✅ test_agentic_process_api (mocked); test_cli_driver_contract (codex/copilot never emit fork flag) | ✅ test_agentic_process_actions (sibling id + fork source) | ✅L classify_session | ◐ process-toolbar (mocked) |
| queue family (`enqueue`/`dequeue`/`clear-queue`/`set-queue-enabled`) | ✅ test_prompt_queue (logic) | ✅ test_agentic_process_actions (HTTP wrappers) | ✅L chat_terminal_switch_stress (enqueue) | ❌ |
| `set-visible` | ❌ | ✅ test_agentic_process_actions (flips `visible` only, never `pty_mode`, both directions) | ✅ agentic_process_fe_contract (+L chat_terminal_switch_stress) | ◐ new-agentic-tab-loader-regression |
| `input` | ❌ | ✅ test_agentic_process_actions (stages onto queue, headless) | ✅L stress | ◐ agentic_process_stress |
| `submit` | ❌ | ✅ test_agentic_process_actions (nothing-staged fails; staged head schedules drain) | ✅L plan_detection, chat_terminal_switch_stress | ❌ |
| `execute` | ✅ test_agentic_process_status (serializer paths) | ✅ test_agentic_process_execute (headless round-trip, session id capture) | ✅L agentic_process_execute | ❌ |
| `prompt` | ❌ | ✅ test_agentic_process_execute (streams FlowData+end); 409 via mid_turn_guard | ✅L agentic_process_execute | ◐ agentic_process_stress |
| `cancel-prompt` | ❌ | ✅ test_agentic_process_execute (terminates in-flight; no-turn fails) | ❌ | ❌ |
| `execute-plan` / `update-plan` | ✅ test_execute_plan_prompt, test_plan_auto_approve | ✅ test_agentic_process_plan_actions | ❌ | ❌ |
| `transcript` (plan/prompts/full) | ◐ test_codex_transcript_resolution | ✅ test_agentic_process_actions (prompts/full/plan; unknown subpath fails) | ❌ | ❌ |
| `get-plan` | ◐ | ✅ test_agentic_process_actions (alias, no session) | ✅L plan_detection | ❌ |
| `load-embedded-agent` | ❌ | ❌ | ✅L load_embedded_agent | ❌ |
| `load-embedded-skill` | ✅ test_agentic_process_skill_loading | ❌ | ✅L system_skills | ❌ |
| `attach-`/`detach-`/`list-embedded-assets` | ❌ | ✅ test_agentic_process_actions (`list`); attach/detach ❌ | ✅L embedded_assets (attach+detach) | ❌ |
| `get-assets` | ✅ test_agentic_process_get_assets | ❌ | ✅ project_context_dir | ❌ |
| `get-history` | ✅ test_worker_history | ✅ test_agentic_process_actions (empty is success) | ✅ chat_ui_vs_pty_content | ◐ error-rendering |
| `restart-info` | ✅ test_agentic_process_restart_info | ✅ test_agentic_process_actions (no baseline) | ❌ | ◐ CommandStatusViewer |
| `cmd-line` | ✅ test_serialize_no_transcript_parse | ✅ test_agentic_process_actions (returns key) | ❌ | ❌ |
| `status` | ✅ test_agentic_process_status | ✅ test_agentic_process_status_api | ◐ | ✅ WorkerStatusChip, process-status-line |
| `get-host` | ❌ | ✅ test_agentic_process_actions (resolves local port; rejects out-of-range) | ❌ | ❌ |
| `set-graph-context` | ❌ | ✅L test_context_process | ❌ | ❌ |
| `add-dir` / `remove-dir` | ✅ via get_assets + restart_snapshot | ✅ test_agentic_process_actions (add then remove) | ❌ | ❌ |
| `open` | ◐ lifecycle/latched_start_failure | ✅ test_pty_process_e2e | ✅ chat_ui_vs_pty_content, pty_test | ✅ new-agentic-tab-loader-regression |
| `os-status` | ❌ | ✅ test_agentic_process_actions (ready_false, no shell) | ✅ agentic_survives_restart | ❌ |
| `close` | ✅ test_process_lifecycle | ✅ test_pty_close_context | ◐ | ◐ tab-close-last-in-project |
| `input-dir` | ❌ | ✅ test_agentic_process_actions (abs path + compute node) | ❌ | ❌ |
| `createProcess` (ComputeNode) | ✅ test_compute_node_spawn_sites | ✅ pty_process_e2e + lifecycle | ✅ via openTab | ✅ tab loaders |
| `upsertSessionProcess` (ComputeNode) | ✅ test_compute_node_spawn_sites | ✅ test_pty_process_e2e | ❌ | ❌ |

TS methods: `appendUserMessage` and `getOutputs` now covered by
`agentic_process_fe_contract.test.ts` (ingest-once + dedup; getByWorkerId
null-on-404/workflow-run short-circuit). Still uncovered: `wait` /
`waitForComplete` / `waitForIdle` (only `waitForReady`, long-only).

**Long-ONLY actions** (no fast-suite coverage on ANY front): `load-embedded-agent`,
`attach-`/`detach-embedded-asset`, `set-graph-context`. (Previously also
switch-mode/fork/set-visible/input/submit/execute/prompt/get-plan — all now have
fast api coverage via `test_agentic_process_actions.py` /
`test_agentic_process_execute.py` / `test_agentic_process_mid_turn_guard.py`.)

## Shell ([interface](./shell.md))

| Action / method | U | A | V | R |
|---|---|---|---|---|
| `open` action | ✅ test_shell_api | ✅ test_shell_lifecycle, test_shell_proc_interface | ✅ shell_tabs, test-shell-lifecycle | ◐ terminal-tab-switch |
| `close` action | ✅ test_shell_api | ✅ test_shell_lifecycle | ✅ shell_tabs | ❌ |
| `run` action | ❌ | ✅ test_shell_lifecycle | ✅ shell_run_setenv (stdout/stderr/exit) | ❌ |
| `set-env` action | ✅ test_shell_api | ✅ test_shell_lifecycle | ✅ shell_run_setenv (persist + merge) | ❌ |
| `start_pty` / stop / restart | ✅ (+ concurrent-start → exactly-one, test_shell_proc_interface) | ✅ | ✅ (+L recovery suites) | — |
| `write` / `read` / `output` | ✅ test_shell_io_worker | ✅ shell_write_echo, read_survives_kill | ◐ | ◐ pty_events_viewer |
| **`write_then_submit`** | ✅ test_shell_io_worker (two ordered writes; actually submits) | ❌ | ❌ | ❌ |
| `wait_for_input_ready` | ✅ test_shell_io_worker (ready + timeout) | ❌ | ❌ | — |
| **`launch` / shell_mode=True legacy** | ✅ test_shell_io_worker (discovers worker child, persists cmd) | ◐ long-only indirect | ❌ | — |
| `set_worker_pid_direct` | ✅ test_shell_io_worker (reads pty pid immediately) | ◐ implicit | ❌ | — |
| `worker_alive` / `has_attachable_pty` | ✅ test_shell_io_worker (pid-gone / cmdline match/mismatch / dead-pty raises) | ✅ pty_recovery_on_demand | ◐ L | — |
| `rename` (entity) | ◐ | ✅ canonical-put + tab_rename.test.ts | — | ◐ |
| **rename-rules `cleanTitle`/`allowRename`** (e3710f9c) | — | — | — | ✅ rename-rules.test.ts (cleanTitle/allowRename/nextTerminalName/shouldAutoSaveTitleForTarget) |
| TabbedTerminal / xterm attach | — | — | ◐ | ✅ terminal-tab-switch, state-guards, WorkerToolbar |
| PtyConnection | — | — | ◐ pty_test, L pty_event_fire | ◐ pty_corruption |

## PTY layer ([interface](./pty-layer.md))

| Surface item | U | A | V | R |
|---|---|---|---|---|
| PtyRegistry attach/detach/park/resume | ✅ test_pty_session_manager | ✅ test_pty_reconnect_regression, test_pty_close_context | ❌ | ❌ |
| Reaper (`cleanup_expired_sessions`) | ✅ unit-only (dead code in prod) | ❌ | ❌ | ❌ |
| Reaper loop (`start/stop_cleanup_task`) | ❌ (deferred — wiring intentionally unbuilt) | ❌ | ❌ | ❌ |
| Restart/singleton reset | ✅ test_pty_session_survives_restart | ✅ test_pty_recovery_on_demand | ✅ pty_survives_restart | ❌ |
| PtyStreamFile core + truncation + v0/salvage | ✅ test_pty_stream_file | ✅ test_pty_stream_truncation (real PTY past cap → replays tail) | ◐ trunc fixtures | ❌ |
| seq epochs across respawn | ✅ test_pty_stream_seq_epochs | ◐ | ✅ pty-replay-production | ❌ |
| Provider spawn/input/resize happy path | ✅ test_local_compute_provider | ✅ (+L test_shell_pty) | — | — |
| **Provider retry-on-dead → bare-shell respawn** | ✅ test_provider_dead_pty_no_bare_respawn (input/resize on dead PTY raise, no bare respawn; recovery respawn with spawn_args still works) | ❌ | ❌ | ❌ |
| Provider env construction | ✅ | ◐ | ❌ | ❌ |
| terminal-command ops start/attach/input/resize/close | ✅/— | ✅ | ✅ pty_test (start) | ◐ pty_corruption (attach) |
| **terminal-command ops `list` / `rename`** | ✅ test_pty_terminal_command_ops (list enriches w/ agentic id + context guards; rename sets/rejects) | ❌ | ❌ | ❌ |
| terminal-command op `ping` | ✅ test_pty_terminal_command_ops (alive true/false; missing id fails) | ◐ | ❌ | ❌ |
| `GET /shell/{id}/pty-stream` | — | ✅ test_pty_stream_endpoint | ✅ pty_stream_replay (framed 200; 404 unknown) | ❌ |
| **`_PTY_CAP=70` FIFO eviction** | ✅ test_pty_terminal_command_ops (evicts oldest first; no eviction below cap) | ❌ | ❌ | ❌ |
| FE pty-replay.ts + pty-sync conformance | — | — | ✅ pty-replay-production + pty_stream_replay + ts_sdk pty-sync (12u/11vt/3browser) | — |

## ComputeNode ([interface](./compute-node.md))

| Action group (mixin) | U | A | V | R |
|---|---|---|---|---|
| PtyActions | ◐ (streaming tests are placeholders) | ✅ session-transcript, discovery, close-context, stream-endpoint (+L) | ✅ shell_tabs, test-shell-lifecycle (+L) | ◐ L-only |
| Ops (`ops/command` ± streaming) | ✅ test_compute_streaming (realtime/chunking/concurrent/large/foreground) | ✅ test_compute_node_actions (buffered + streaming + missing-command guard) | ✅ compute_node_command_service (executeCommand[Streaming], stderr, interleave) | ❌ |
| Scan (incl. createProcess/upsert/findSession) | ✅ test_compute_node_spawn_sites | ✅ test_pty_process_e2e (upsert idempotent, findSession ×3) | ✅ compute_node_command_service (findSession null-on-404) | ◐ loaders |
| **Desktop** (9 actions) | ❌ | ✅ test_compute_node_actions (machine-status, system-profile, json-file round-trip, pick-folder, open-terminal, open-external, generate-amd-plan) | ❌ | ❌ |
| FsRecords | ◐ | ✅ fs_records suites | ✅ | ◐ revisions UI |
| **Analytics** (cost-overview, claude-context) | ❌ | ✅ test_compute_node_actions (cost-overview shape, claude-context envelope) | ❌ | ❌ |
| core (tabs, get-cwd, git-ops, worker-history, get-host…) | ✅ tabs/order/worker_history | ✅ get_cwd, git_ops, create_project_from_git; test_compute_node_actions (get-host redirect + range guard, worker-history limit/project-scoped) | ✅ tab_* suites | ✅ tab tests, useClaudeHistory |

Formerly called out and now covered: **`get-host`** (both AgenticProcess and
ComputeNode variants), **worker-history HTTP action**, **findSession null-on-404**,
and the **`test_compute_streaming.py` / `test_compute_node_env.py` placeholders**
(both now carry real streaming / env-propagation assertions, not `*_placeholder`
stubs). `test_compute_node_env.py` covers env visible-to-child, non-persistence,
set-env persist/remove/update/special-chars.

## CLI drivers ([interface](./cli-drivers.md))

| Contract item | claude | codex | copilot |
|---|---|---|---|
| `cli_options` argv (U) | ✅ 31 cases | ✅ 11 | ✅ 6 |
| real-CLI execution (A/V long) | ✅ test_claude_cli, agentic_process_execute, plan_detection | ✅L test_cli_driver_binary_smoke (version + headless turn parses) | ✅L test_cli_driver_binary_smoke (version + headless turn parses) |
| `stream_worker` (U) | ✅ 7 cases | ✅ test_codex_cli_stream_worker (session-id capture, fresh-id-per-turn hazard, tee, missing-binary, non-zero exit, close) | ✅ 5 cases |
| `load_history` / parsers (U) | ✅ + drift guards (ai-title) | ✅ static fixtures + naming-event-is-meta (test_codex_parser) | ✅ static fixtures + session-title-is-meta (test_copilot_parser) |
| **`has_resumable_session`** | ✅ test_cli_driver_contract (jsonl present/absent/no-session-id) | ✅ test_cli_driver_contract (rollout present/absent/no-session-id) | ✅ test_cli_driver_contract (session-file / process-local tee / absent / no-session-id) |
| plan mode | ✅ all four fronts | ✅ test_cli_driver_contract (does-not-support) | ✅ test_cli_driver_contract (does-not-support) |
| `compose_prompt` (embedded agents) | ✅ test_cli_driver_contract (passthrough) | — (shared) | — (shared) |
| System instruction assets | ✅ test_system_instruction_assets + test_cli_options_system_prompt | ✅ same | ✅ same |

Shared: `WorkerCLIOptions` round-trips ✅, system-instruction sink ✅, `build_env`
pin ✅, restart-snapshot golden ✅ (+L restart_required); `restart_required`
flip-on-config-change / clear-on-revert now unit-pinned
(test_agentic_process_restart_snapshot). Also pinned in test_cli_driver_contract:
codex/copilot never emit a fork-session flag, never pin resume cwd, and omit
`report_event` (claude returns the unhandled stub).

**codex/copilot still have no transcript-schema *drift* test** — the naming-event
fixes are single-event assertions, not the ai-title-style drift guard claude has.

## Status model ([interface](./status-model.md))

| Surface item | U | A | V | R |
|---|---|---|---|---|
| Enums + running/terminal/error set parity | ✅ vs status_sets.json | ✅ lifecycle FSM | ✅ vs status_sets.json | ◐ chips |
| **`worker_ready_for_input` fixture key** | ✅ test_agentic_process_status (set matches spec) | — | ✅ agentic-status (READY_WORKER_STATUSES vs fixture) | — |
| process_running/startable parity | ✅ test_agentic_process_status (both sets) | ◐ | ✅ ts side | — |
| **backend `is_busy`/_BUSY** | ✅ test_agentic_process_status (busy set matches literal) | ❌ | n/a (TS isBusy ≠ pair) | ❌ |
| classify_execution_mode / get_worker_mode | ✅ truth tables + hidden-live-pty (test_agentic_process_status, test_pty_recovery_reconcile) | ❌ | ✅ worker-mode, agentic-status (pty_mode-absent fallback) | ◐ |
| is_ready_for_input | ✅ | ◐ | ✅ | ✅ status-line + ChatComposerBar (composer gates on isWorkerRunning; status-line on isReadyForInput) |
| _tail_status + projections | ✅ ~20 cases + projection tests | ❌ | n/a | n/a |
| fetch_worker_status → serialize | ✅ test_agentic_process_status (api_json_serializer injects worker_status + ready; ready-false-when-not-running; skip-context suppresses) | ✅ status_api | ❌ | ❌ |
| ProcessCounters / parseStatusReport | ✅ | ✅ L report_stream | ✅ | ✅ counters |

Parity fixture `test_fixtures/status_sets.json` is now consumed on both sides
**including ready-for-input** (py test_agentic_process_status
`test_ready_for_input_set_matches_spec`, ts agentic-status
`READY_WORKER_STATUSES matches fixture worker_ready_for_input`). The
`to_dict`-branch caveat is gone: the dead `to_dict` override was removed
(2026-07-02), so `api_json_serializer` is the single isolated serialize seam and
is directly asserted.

---

## Cross-area findings

Most of the formerly high-risk holes are closed as of 2026-07-02. Remaining/updated:

### Still uncovered / deferred

1. **Reaper loop wiring** (`start/stop_cleanup_task`) — **deliberately deferred**;
   the reaper is dead code in prod (the `_PTY_CAP=70` FIFO eviction, now tested, is
   the live PTY-leak backstop). Not a regression risk until the loop is wired.
2. **codex `turn.failed` / parser error path** — the codex parser emits an
   `UnknownEntry` for the error/`turn.failed` event shape (reported by B-series,
   **not fixed**). Only the naming-event-is-meta case is pinned.
3. **Long-only CLI matrix beyond claude** — codex/copilot real-CLI is now
   `test_cli_driver_binary_smoke.py` but stays DEEP_TESTING + binary-gated; a
   missing binary still leaves zero signal.
4. **`load-embedded-agent`, `attach-`/`detach-embedded-asset`, `set-graph-context`** —
   fast suites still blind (long-only).

### Now covered (was zero-coverage, high-risk)

- **`self-restart`** — `test_agentic_process_actions` (detached schedule + emits
  `worker.restarted`).
- **`has_resumable_session`** — `test_cli_driver_contract` on all three drivers.
- **Provider input/resize retry → bare-shell respawn** — `test_provider_dead_pty_no_bare_respawn`
  (the de-agenting hazard: raises, never bare-respawns; spawn_args recovery intact).
- **`get-host`** (AgenticProcess + ComputeNode) — `test_agentic_process_actions` /
  `test_compute_node_actions`.
- **Mid-turn 409 guards** — `test_agentic_process_mid_turn_guard` (switch-mode +
  restart while a prompt is in flight) and `cancel-prompt` (`test_agentic_process_execute`).
- **`set-visible`** — `test_agentic_process_actions` + `agentic_process_fe_contract`
  (mutates `visible` only, never `pty_mode`).
- **`worker_ready_for_input` parity** — asserted both sides (see status model).
- **`write_then_submit`** — `test_shell_io_worker`.
- **`_PTY_CAP=70` FIFO eviction** — `test_pty_terminal_command_ops`.
- **ready-for-input parity** — py/ts fixture key both consumed.

### Long-test-only coverage (fast suites still blind)

`load-embedded-agent`, embedded asset attach/detach, `set-graph-context`,
chat⇄terminal switching under load. `execute`/`prompt`/queue-drain now have fast
api coverage in addition to the long suites.

<a id="2026-07-02-expansion"></a>
### 2026-07-02 expansion

New files this cycle — pytest: `test_agentic_process_actions.py`,
`test_agentic_process_mid_turn_guard.py`, `test_agentic_process_execute.py`
(was 0-byte), `test_compute_node_actions.py`, `test_pty_stream_truncation.py`,
`test_cli_driver_contract.py`, `test_codex_cli_stream_worker.py`,
`test_provider_dead_pty_no_bare_respawn.py`, `test_pty_terminal_command_ops.py`,
`test_shell_io_worker.py`, `long_tests/test_cli_driver_binary_smoke.py`; vitest:
`agentic_process_fe_contract`, `agentic_spawn_pty_mode`,
`compute_node_command_service`, `pty_stream_replay`, `shell_run_setenv`,
`react/ChatComposerBar`, `react/unit/rename-rules`; plus additions to
`test_agentic_process_status`, `test_compute_node_env`, `test_compute_streaming`,
`test_pty_recovery_reconcile`, the codex/copilot parser tests, and the
`agentic-status`/`worker-mode` vitest suites.

**Remaining known gaps** (intentionally not closed this cycle):
- Reaper loop wiring deferred (dead code; `_PTY_CAP` is the live backstop).
- Codex parser error / `turn.failed` gap (`UnknownEntry`) — reported, not fixed.
- A handful of vitest **live-worker** items were deferred to the pytest/long tier
  (documented in the `agentic_process_fe_contract.test.ts` file header).
- Pre-existing `test_shell_proc_interface.py::test_shell_survives_kill_and_reopen`
  flake (PTY reopen/echo stall on repeat runs) is unrelated to this expansion.
