# Test coverage — the agentic-process stack, per topic × per front

Audited 2026-07-02 against the interface surfaces in this folder. Each cell was
confirmed by opening the test, not by grep alone.

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
| `switch-mode` | ✅ test_agentic_process_switch_mode (transitions only — **no mid-turn-409 test**) | ❌ | ✅L chat_terminal_switch_stress | ❌ |
| `restart` | ✅ restart_snapshot, pty_session_survives_restart | ✅ pty_recovery_on_demand, resume_after_restart | ✅ agentic_survives_restart, pty_survives_restart | ◐ shell_stress, CommandStatusViewer |
| `self-restart` | ❌ | ❌ | ❌ | ❌ |
| `recover-project` | ❌ | ✅ test_project_recovery | ❌ | ❌ |
| `fork` | ✅ test_agentic_process_api (mocked) | ❌ | ✅L classify_session | ◐ process-toolbar (mocked) |
| queue family (`enqueue`/`dequeue`/`clear-queue`/`set-queue-enabled`) | ✅ test_prompt_queue (logic; HTTP wrappers not hit) | ❌ | ✅L chat_terminal_switch_stress (enqueue) | ❌ |
| `set-visible` | ❌ | ❌ | ✅L chat_terminal_switch_stress | ◐ new-agentic-tab-loader-regression |
| `input` | ❌ | ❌ | ✅L stress (ambiguous w/ `send`) | ◐ agentic_process_stress |
| `submit` | ❌ | ❌ | ✅L plan_detection, chat_terminal_switch_stress | ❌ |
| `execute` | ❌ (`test_agentic_process_execute.py` is a 0-byte file) | ❌ | ✅L agentic_process_execute | ❌ |
| `prompt` | ❌ | ✅L prompt_streaming (no 409-guard test) | ✅L agentic_process_execute | ◐ agentic_process_stress |
| `cancel-prompt` | ❌ | ❌ | ❌ | ❌ |
| `execute-plan` / `update-plan` | ✅ test_execute_plan_prompt, test_plan_auto_approve | ✅ test_agentic_process_plan_actions | ❌ | ❌ |
| `transcript` (plan/prompts/full) | ◐ test_codex_transcript_resolution | ❌ | ❌ | ❌ |
| `get-plan` | ◐ | ❌ | ✅L plan_detection | ❌ |
| `load-embedded-agent` | ❌ | ❌ | ✅L load_embedded_agent | ❌ |
| `load-embedded-skill` | ✅ test_agentic_process_skill_loading | ❌ | ✅L system_skills | ❌ |
| `attach-`/`detach-`/`list-embedded-assets` | ❌ | ❌ | ✅L embedded_assets (attach+detach; `list` ❌) | ❌ |
| `get-assets` | ✅ test_agentic_process_get_assets | ❌ | ✅ project_context_dir | ❌ |
| `get-history` | ✅ test_worker_history | ❌ | ✅ chat_ui_vs_pty_content | ◐ error-rendering |
| `restart-info` | ✅ test_agentic_process_restart_info | ❌ | ❌ | ◐ CommandStatusViewer |
| `cmd-line` | ✅ test_serialize_no_transcript_parse | ❌ | ❌ | ❌ |
| `status` | ✅ test_agentic_process_status | ✅ test_agentic_process_status_api | ◐ | ✅ WorkerStatusChip, process-status-line |
| `get-host` | ❌ | ❌ | ❌ | ❌ |
| `set-graph-context` | ❌ | ✅L test_context_process | ❌ | ❌ |
| `add-dir` / `remove-dir` | ✅ via get_assets + restart_snapshot | ❌ | ❌ | ❌ |
| `open` | ◐ lifecycle/latched_start_failure | ✅ test_pty_process_e2e | ✅ chat_ui_vs_pty_content, pty_test | ✅ new-agentic-tab-loader-regression |
| `os-status` | ❌ | ❌ | ✅ agentic_survives_restart | ❌ |
| `close` | ✅ test_process_lifecycle | ✅ test_pty_close_context | ◐ | ◐ tab-close-last-in-project |
| `input-dir` | ❌ | ❌ | ❌ | ❌ |
| `createProcess` (ComputeNode) | ✅ test_compute_node_spawn_sites | ✅ pty_process_e2e + lifecycle | ✅ via openTab | ✅ tab loaders |
| `upsertSessionProcess` (ComputeNode) | ✅ test_compute_node_spawn_sites | ✅ test_pty_process_e2e | ❌ | ❌ |

TS methods with no coverage anywhere: `appendUserMessage`, `getOutputs`, `wait`/`waitForComplete`/`waitForIdle` (only `waitForReady`, long-only).

**Long-ONLY actions** (no fast-suite coverage on ANY front; long suites are
DEEP_TESTING-gated and usually skipped in CI): `switch-mode` (guard also
untested), `fork`, `set-visible`, `input`, `submit`, `execute`, `prompt`,
`get-plan`, `load-embedded-agent`, `attach-/detach-embedded-asset`,
`set-graph-context`.

## Shell ([interface](./shell.md))

| Action / method | U | A | V | R |
|---|---|---|---|---|
| `open` action | ✅ test_shell_api | ✅ test_shell_lifecycle, test_shell_proc_interface | ✅ shell_tabs, test-shell-lifecycle | ◐ terminal-tab-switch |
| `close` action | ✅ test_shell_api | ✅ test_shell_lifecycle | ✅ shell_tabs | ❌ |
| `run` action | ❌ | ✅ test_shell_lifecycle | ❌ | ❌ |
| `set-env` action | ✅ test_shell_api | ✅ test_shell_lifecycle | ❌ | ❌ |
| `start_pty` / stop / restart | ✅ | ✅ | ✅ (+L recovery suites) | — |
| `write` / `read` / `output` | ✅ | ✅ shell_write_echo, read_survives_kill | ◐ | ◐ pty_events_viewer |
| **`write_then_submit`** | ❌ | ❌ | ❌ | ❌ |
| `wait_for_input_ready` | ❌ | ❌ | ❌ | — |
| **`launch` / shell_mode=True legacy** | ❌ | ◐ long-only indirect | ❌ | — |
| `set_worker_pid_direct` | ❌ | ◐ implicit | ❌ | — |
| `worker_alive` / `has_attachable_pty` | ◐ via agentic | ✅ pty_recovery_on_demand | ◐ L | — |
| `rename` (entity) | ◐ | ✅ canonical-put + tab_rename.test.ts | — | ◐ |
| **rename-rules `cleanTitle`/`allowRename`** (e3710f9c) | — | — | — | ❌ (only `nextTerminalName` tested) |
| TabbedTerminal / xterm attach | — | — | ◐ | ✅ terminal-tab-switch, state-guards, WorkerToolbar |
| PtyConnection | — | — | ◐ pty_test, L pty_event_fire | ◐ pty_corruption |

## PTY layer ([interface](./pty-layer.md))

| Surface item | U | A | V | R |
|---|---|---|---|---|
| PtyRegistry attach/detach/park/resume | ✅ test_pty_session_manager | ✅ test_pty_reconnect_regression, test_pty_close_context | ❌ | ❌ |
| Reaper (`cleanup_expired_sessions`) | ✅ unit-only (dead code in prod) | ❌ | ❌ | ❌ |
| Reaper loop (`start/stop_cleanup_task`) | ❌ | ❌ | ❌ | ❌ |
| Restart/singleton reset | ✅ test_pty_session_survives_restart | ✅ test_pty_recovery_on_demand | ✅ pty_survives_restart | ❌ |
| PtyStreamFile core + truncation + v0/salvage | ✅ test_pty_stream_file | ✅ endpoint only (no >10MB integration) | ◐ trunc fixtures | ❌ |
| seq epochs across respawn | ✅ test_pty_stream_seq_epochs | ◐ | ✅ pty-replay-production | ❌ |
| Provider spawn/input/resize happy path | ✅ test_local_compute_provider | ✅ (+L test_shell_pty) | — | — |
| **Provider retry-on-dead → bare-shell respawn** | ❌ | ❌ | ❌ | ❌ |
| Provider env construction | ✅ | ◐ | ❌ | ❌ |
| terminal-command ops start/attach/input/resize/close | ✅/— | ✅ | ✅ pty_test (start) | ◐ pty_corruption (attach) |
| **terminal-command ops `list` / `rename`** | ❌ | ❌ | ❌ | ❌ |
| terminal-command op `ping` | ❌ | ◐ | ❌ | ❌ |
| `GET /shell/{id}/pty-stream` | — | ✅ test_pty_stream_endpoint | ❌ | ❌ |
| **`_PTY_CAP=70` FIFO eviction** | ❌ | ❌ | ❌ | ❌ |
| FE pty-replay.ts + pty-sync conformance | — | — | ✅ pty-replay-production + ts_sdk pty-sync (12u/11vt/3browser) | — |

## ComputeNode ([interface](./compute-node.md))

| Action group (mixin) | U | A | V | R |
|---|---|---|---|---|
| PtyActions | ◐ (streaming tests are placeholders) | ✅ session-transcript, discovery, close-context, stream-endpoint (+L) | ✅ shell_tabs, test-shell-lifecycle (+L) | ◐ L-only |
| Ops (`ops/command` ± streaming) | ◐ placeholders | ◐ setup via fixtures only | ❌ executeCommand/Streaming | ❌ |
| Scan (incl. createProcess/upsert/findSession) | ✅ test_compute_node_spawn_sites | ✅ test_pty_process_e2e (upsert idempotent, findSession ×3) | ◐ | ◐ loaders |
| **Desktop** (9 actions) | ❌ | ◐ open-external only (1/9) | ❌ | ❌ |
| FsRecords | ◐ | ✅ fs_records suites | ✅ | ◐ revisions UI |
| **Analytics** (cost-overview, claude-context) | ❌ | ❌ | ❌ | ❌ |
| core (tabs, get-cwd, git-ops, worker-history…) | ✅ tabs/order/worker_history | ✅ get_cwd, git_ops, create_project_from_git | ✅ tab_* suites | ✅ tab tests, useClaudeHistory |

Called out: **`get-host` — zero coverage on every front** (powers the vibe
live-preview); `worker-history` HTTP action never api-tested (unit+react only);
findSession TS null-on-404 contract untested; `test_compute_streaming.py` /
`test_compute_node_env.py` are all `*_placeholder` stubs.

## CLI drivers ([interface](./cli-drivers.md))

| Contract item | claude | codex | copilot |
|---|---|---|---|
| `cli_options` argv (U) | ✅ 31 cases | ✅ 11 | ✅ 6 |
| real-CLI execution (A/V long) | ✅ test_claude_cli, agentic_process_execute, plan_detection | ❌ none (not even binary-gated) | ❌ none |
| `stream_worker` (U) | ✅ 7 cases | **❌ no test file** | ✅ 5 cases |
| `load_history` / parsers (U) | ✅ + drift guards (ai-title) | ✅ static fixtures, no drift test | ✅ static fixtures, no drift test |
| **`has_resumable_session`** | ◐ indirect only (resume_after_restart) | ❌ | ❌ |
| plan mode | ✅ all four fronts | ◐ negative unasserted | ◐ negative unasserted |
| `compose_prompt` (embedded agents) | ◐ hammer only | ❌ | ❌ |

Shared: `WorkerCLIOptions` round-trips ✅, system-prompt sink ✅, `build_env`
pin ✅, restart-snapshot golden ✅ (+L restart_required).

## Status model ([interface](./status-model.md))

| Surface item | U | A | V | R |
|---|---|---|---|---|
| Enums + running/terminal/error set parity | ✅ vs status_sets.json | ✅ lifecycle FSM | ✅ vs status_sets.json | ◐ chips |
| **`worker_ready_for_input` fixture key** | ❌ not asserted | — | ❌ not asserted | — |
| process_running/startable parity | ❌ py side | ◐ | ✅ ts side | — |
| **backend `is_busy`/_BUSY** | ❌ | ❌ | n/a (TS isBusy ≠ pair) | ❌ |
| classify_execution_mode / get_worker_mode | ✅ truth tables (lock in `visible`-keying debt) | ❌ | ✅ | ◐ |
| is_ready_for_input | ✅ | ◐ | ✅ | ✅ status-line (composer gate untested) |
| _tail_status + projections | ✅ ~20 cases + projection tests | ❌ | n/a | n/a |
| fetch_worker_status → serialize | ◐ | ✅ status_api (`to_dict` branch not isolated) | ❌ | ❌ |
| ProcessCounters / parseStatusReport | ✅ | ✅ L report_stream | ✅ | ✅ counters |

Parity fixture `test_fixtures/status_sets.json` **is** consumed on both sides
(py test_agentic_process_status, ts agentic-status.test.ts) for
running/terminal/error — but not for ready-for-input.

---

## Cross-topic findings

### Zero-coverage, high-risk (ranked)

1. **`self-restart`** — all fronts dark: detached exit+start and the
   `worker.restarted` WS re-attach event.
2. **`has_resumable_session`** — no direct test on any driver; the
   resume-vs-fresh gate regresses silently (codex/copilot documented failure
   modes included).
3. **Provider input/resize retry → bare-shell respawn** — the confirmed
   de-agenting hazard has no test on any front.
4. **`get-host`** (both AgenticProcess and ComputeNode variants) — powers the
   vibe live-preview iframe; zero coverage.
5. **Mid-turn guards** — the 409 contract is untested everywhere: switch-mode
   →CLI lock rejection, prompt lock, and `cancel-prompt` (zero coverage).
6. **`set-visible`** — nothing asserts its invariant (mutates `visible` only,
   never `pty_mode`); this is the quadrant behind the recovery bug.
7. **`worker_ready_for_input` parity** — fixture key asserted by neither side;
   the send-a-prompt gate can diverge backend↔frontend undetected.
8. **`fork`** — never driven live (`--resume --fork-session --session-id`);
   unit and react are mocked, vitest long-only.
9. **`write_then_submit`** — the Codex/Copilot paste-vs-Enter TUI behavior,
   zero coverage.
10. **`_PTY_CAP=70` FIFO eviction** — the only live PTY-leak backstop (reaper
    is unwired dead code), untested.

### Long-test-only coverage (fast suites blind)

`execute` (headless), `prompt` streaming, queue drain end-to-end, embedded
agents/assets, `set-graph-context`, chat⇄terminal switching under load,
`get-plan`. A long-suite skip (or codex/copilot binary absence) leaves these
paths with no signal at all — the real-CLI matrix is claude-only.

### Front-shaped holes

- **vitest**: Shell `setEnv`/`run` wrappers, `executeCommand(Streaming)`,
  findSession, PtyRegistry semantics — the TS envelope layer is much thinner
  than the pytest layer.
- **react**: rename-rules `cleanTitle`/`allowRename` (commit e3710f9c) have no
  test; prompt-composer gating on `isReadyForInput` untested; plan actions
  have no UI test.
- **pytest api**: many AgenticProcess GET actions (`get-history`,
  `restart-info`, `cmd-line`, `transcript`, `list-embedded-assets`,
  `input-dir`, `os-status`) are unit- or vitest-only — the HTTP route layer
  (auth/envelope/serialization) is unexercised for them; same for
  `worker-history` on ComputeNode.
- **Placeholders masquerading as coverage**: `tests/unit/test_compute_streaming.py`
  and `test_compute_node_env.py` are `*_placeholder` stubs; the empty
  `tests/api/test_agentic_process_execute.py` should be filled or deleted.
