# QA Cycle State — 2026-08-24T22-20-30Z

- Branch: 20260824-221153-qa-e2e-agent @ 08eeefb91
- Host: linux, 4 cores, 31GB RAM, load at start: 0.57 0.91 0.55
- Repo: /home/claudeuser/Flowpad workspace/flowpad
- Toolchain: python3 3.13.5 (venv 3.10.17), node v24.19.0, uv 0.12.5
- **`python` is NOT on PATH on this host** — every skill command written as `python -m pytest` must be run as `uv run python -m pytest`.
- Main dev backend ($LOCAL_SERVER_PORT=9008) / frontend ($VITE_PORT=4098): NOT running. This cycle will NOT clear or mutate them.
- Instances launched by this cycle: (none yet)
- Results dir: ui/tests/manual_regression/_results/2026-08-24T22-20-30Z

## Phase dispositions

| Phase | Suite | Status | Verdict |
|---|---|---|---|
| 1 | pytest unit | **PASS** | 6449 passed, 21 skipped, 4 xfailed, 0 failed (632s) |
| 2 | pytest api | **PASS** | 805 passed, 11 skipped, 0 failed, PYTEST_EXIT=0 (1104s) — after the env-probe fix; was 18 failed |
| 3 | pytest long | **RED — 2 failing (2 flagged)** | 112 passed, 51 skipped, 5 xfailed, 2 failed, PYTEST_EXIT=1 (746s). Baseline was 110 passed / 3 failed; 1 fixed in app, 1 fixed in test, 2 flagged (codex+copilot CLIs absent). Plus 2 harness flags. |
| 4 | vitest unit | **PASS** | 3540 passed, 436 files, VITEST_EXIT=0 |
| 5 | vitest api | **PASS** | 252 passed, 1 skipped, 0 failed, VITEST_EXIT=0 (no-bail run). Was 2 failed + 3 failed suites + 12 skipped; one env fix recovered 11 masked tests. |
| 6 | vitest react | RUNNING | — |
| 7 | vitest long | PENDING | — |
| 8 | vitest headless | PENDING | — |
| 9 | pytest hub | PENDING | — |
| 10 | vitest hub | PENDING | — |
| 11 | playwright .md.ts sweep | PENDING | — |
| 12 | author .md.ts for orphan .md | PENDING | — |

## Test index
- Rebuilt `.flow/skills/agentic-qa/test_index.md`: 137 `.md` specs, 159 `.md.ts`, across 29 categories.
- **Phase 12 scope (filesystem `comm -23` diff, authoritative): 2 orphan `.md`**
  - `data-sources/credentialed_sources.md`
  - `sandbox/sandbox_share_link.md` (note: `sandbox/` has NO playwright.config.ts)

## Milestone log
- 2026-08-24T22-20-30Z cleanup ran: /tmp/flowpad_test_home absent, 0 e2etest-* artifacts. Clean start.
- Carried forward from the aborted 22-14-09Z attempt (process died with its session; artifacts kept):
  - `.venv` (157 pkgs) and `ui/node_modules` (772 entries) are installed and reused.
  - **Hub preflight finding (affects Phases 9 & 10):** `http://localhost:8093/api/v1/health/status` → connection refused. Canonical hub checkout `../test_flowpad/FlowPad` DOES NOT EXIST on this host; no `hub_setup.md` anywhere on disk; no `neo4j` binary; nothing on 7474/7687/8093. To be re-verified and formally dispositioned at Phase 9.
- Phase 1 started: `uv run python -m pytest tests/unit/ -q -rf` (pid 15832).
  - NOTE: an initial launch added `--timeout=600`; `pytest.ini` already sets `--timeout=30`, so that would have RAISED a test timeout (CLAUDE.md non-negotiable). Killed and relaunched with the ini timeout intact. No timeout is raised anywhere in this cycle.

## Fix 1 — capability discovery lost the process PATH (root cause of all 18 Phase 2 failures)

- **Symptom (18 tests, 3 signatures):** `Claude CLI is not installed on this machine.` (7),
  `Command not found: '/home/claudeuser/.local/bin/claude' — no harness.claude.cli installation discovered` (8),
  `assert False is True` on `capability/test` → `available` (2), plus 1 `worker.restarted` follow-on.
- **On/off proof:** `env_probe.probe(['claude'])` with real `$HOME` → `/home/claudeuser/.local/bin/claude`;
  with a sandboxed `$HOME` (what `tests/conftest.py:70` sets) → `None`. Deterministic, both directions.
- **Root cause:** `capture_terminal_path()` runs `$SHELL -ilc 'printf "%s" "$PATH"'` and `probe()` resolved
  executables against **only** that PATH. On this host `~/.local/bin` is prepended by `~/.profile` and
  `~/.bashrc` — neither exists under the test sandbox HOME, and `/etc/profile` does not add it — so the
  captured PATH came back *narrower* than the PATH the server process was already running with. Discovery
  then reported no Claude CLI, which made `AgenticProcess.is_installed()` False → `createProcess` refused
  (400) and PTY spawn raised, even though `spawn_argv[0]` was already the correct, executable absolute path.
- **Classification: app defect (not a test issue).** The narrow-PATH condition is not test-only — a service
  account, a stripped container image, or any launch context whose `$HOME` lacks dotfiles reproduces it. The
  probe must never *lose* a directory the process can already see.
- **Fix:** `flow_sdk/core/capabilities/env_probe.py` — `probe()` now resolves against
  `_merge_paths(capture_terminal_path(), os.environ["PATH"])`. Terminal PATH stays **first**, so the
  documented tie-break ("the binary a terminal would run wins") is preserved; the process PATH is appended,
  de-duplicated, never substituted. No assertion weakened, no timeout/retry touched.
- **Validation:** the 7 affected files re-ran 68 passed / 1 skipped / 0 failed (exit 0); full `tests/api/`
  then re-ran 805 passed / 0 failed (exit 0).

## CIRCUIT BREAKER — meta-RCA on the harness (2 same-class anomalies)

**Anomaly class:** the Phase 3 pytest session died mid-run with `INTERNALERROR`, twice, truncating
the run and destroying its verdict (runs of 63 and 67 tests out of ~170).

**Signature (identical both times):**
```
INTERNALERROR> ... _pytest/_code/source.py ... ast.parse(content, "source", "exec")
INTERNALERROR> ... pytest_timeout.py:317 in handler -> timeout_sigalrm(item, settings)
INTERNALERROR> Failed: Timeout (>30.0s) from pytest-timeout.
```

**Root cause (harness, not product):** `pytest.ini` sets `--timeout=30`, and on POSIX pytest-timeout
defaults to the **SIGALRM** method. The alarm is armed for `test_start + 30s`. When a test *fails*
very close to its own deadline, pytest then formats the failure report — `repr_failure` →
`getstatementrange_ast` → `ast.parse` of the source file — and the still-armed SIGALRM fires **inside
pytest's own reporting machinery**. `timeout_sigalrm` raises `Failed` from a frame pytest cannot
recover in, so the entire session aborts instead of just that test.

**Why it bit here:** this tier's source files are large (`agentic_process.py` is ~5k lines), so the
`ast.parse` step in report formatting is slow enough to be a reliable landing zone for the alarm.

**Remediation (no timeout raised, added, or weakened anywhere):** run this tier with `--tb=no -rf`.
That removes the expensive source-parsing report path — the alarm has no long-running pytest internal
to fire inside — while `-rf` still prints the machine-readable `FAILED <nodeid>` list the verdict is
taken from. Individual failures are then re-run singly to obtain a traceback. `--timeout=30` and every
other budget is untouched; `--timeout-method=thread` was rejected because it kills the whole process
on timeout, which destroys the verdict in a different way.

**Verdict status:** the two crashed Phase 3 runs are recorded as **NO VERDICT** (truncated session),
per Run Integrity. Phase 3's verdict is taken from the `--tb=no` re-run below.

## Fix 2 — stale hook-args assertion (Phase 3, test-issue)
- `tests/long_tests/test_claude_cli.py::test_process_hook_acceptance_uses_real_claude_plugin` asserted
  `handler["args"][-3:] == ["report", "--process-id", id]`, but `claude/driver.py` intentionally appends
  `--wait-for-response` for events whose stdout Claude reads (`_RESPONSE_EVENTS` = SessionStart,
  UserPromptSubmit) — and the fixture's event IS `UserPromptSubmit`. The app is right; the test was stale.
- Fixed by STRENGTHENING: the test now checks EVERY persisted event's handler and asserts the flag is
  present for response events and absent for fire-and-forget ones. `response_events` added to
  `tests/fixtures/process_hook_acceptance.json`. Nothing weakened.

## Fix 3 — `start_pty` never returned the worker's identity to its caller (Phase 3, app defect)
- `start_pty()` runs the launch on `fresh` (a DB reload) so concurrent opens can't double-spawn. Every
  field the launch assigns therefore landed on `fresh` only, while `self` — the object the caller keeps
  using — still read `session_id=None`, `status="new"`. `stream_transcript()` resolves
  `driver.transcript_path(self)`, so it polled a session-less process to its deadline and died with
  `TimeoutError: stream_transcript: transcript file did not appear within timeout`.
- Fix: mirror the worker's IDENTITY (`session_id`, `status`) back onto `self` after the launch.
- **Deliberately narrow, and this was proven the hard way.** Mirroring ALL 11 assigned fields (the
  launch bookkeeping: `context_data`, `last_started_*`, `shell_id`, `sidecar_shell_id`,
  `restart_required`, `start_failure`, `pty_mode`, `visible`) REGRESSED
  `test_create_process_terminal_theme.py` from `3 passed in 13s` to `3 x 60s timeout`. On/off toggle
  confirmed it both ways; the tuple is now identity-only with a comment saying not to widen it.
- Validation: `test_prompt_queue_integration[pty]` FAIL(timeout) -> PASS; terminal_theme 3/3 PASS;
  asset_cleanup PASS; full tier 112 passed (baseline 110).

## Fix 4 — jsdom/Node `AbortSignal` realm split broke the whole api tier's fetch+abort path (Phase 5)
- Symptom A (2 tests): `TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an instance of
  AbortSignal` from `compute_node_command_service.test.ts`.
- Symptom B (3 whole suites, 11 tests skipped): `Error: backend 'projfast' did not come up on :6077`.
  **The backend was healthy.** Its own log showed `Application startup complete` / `Uvicorn running`, and
  a cold boot to `/api/v1/health/status` 200 measured **8s** against a 60s budget. `waitHealthy` passes
  `signal: AbortSignal.timeout(2000)` to `fetch` and swallows the resulting TypeError in its
  "not up yet" catch — so it looped out its whole budget and blamed the backend.
- Root cause (proven by probe): in this tier's jsdom environment every web global is jsdom's, including
  `AbortSignal` — `sig instanceof AbortSignal` is `true` — but global `fetch` is Node's undici, which
  validates against the class it captured at load time. One realm rejects the other's signal. Real
  browsers have a single realm, so there is no product analogue; the SDK is right to pass a signal.
- Fix: `ui/tests/api/jsdomNodeAbort.ts`, a custom Vitest environment that runs builtin jsdom and then
  restores Node's `AbortController`/`AbortSignal` (captured at module scope, before jsdom's `setup()`).
  `tests/api/vitest.config.ts` points `environment` at it. No test or product code changed; no per-file
  workaround; no timeout touched. Rejected alternatives: `@vitest-environment node` per file (the SDK
  needs `document.createElement` for entity decoding) and hand-shimming window/localStorage/location.
- NOT caused by this cycle: toggling `env_probe.py` off reproduced Symptom B identically at baseline.
