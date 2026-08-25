# Flagged — senior dev review required

Flagged is a **RED, unfixed test**. It lets the cycle advance; it is never a pass.

---

## phase3/long_tests/test_agentic_invalid_launch_recovery.py::test_malformed_codex_launch_returns_without_stranding_process
- owner: senior-dev-review
- reason: Required third-party harness CLI unavailable, and installing it is outside the cycle's instance-level ownership.
- evidence: `AssertionError: real codex executable is required for this regression`
  (`tests/long_tests/test_agentic_invalid_launch_recovery.py:149` — `assert shutil.which("codex")`).
  Confirmed on host: `command -v codex` → not installed (nor `copilot`, nor `opencode`; only `claude` is present at `/home/claudeuser/.local/bin/claude`).
- why senior review: The cycle owns the instances it launches, not the machine. Installing a global
  third-party CLI (`npm i -g @openai/codex`) mutates the user's VM and was not authorized, so the
  cycle will not do it unilaterally. There is also a genuine design question underneath: this is the
  ONLY codex test in the tier that hard-`assert`s the binary; its sibling
  `tests/long_tests/test_cli_driver_binary_smoke.py:133` uses
  `pytest.mark.skipif(shutil.which("codex") is None, reason="codex CLI not installed")`. The two
  conventions disagree, and picking one is a policy call, not a QA call.
- recommendation: Either (a) provision codex on the QA host and keep the hard assert — it is a real
  regression guard and skipping it silently loses coverage; or (b) make the gate consistent with the
  smoke test's `skipif`. Do NOT do (b) without deciding whether losing the guard is acceptable.

## phase3/long_tests/test_markdown_index.py::test_markdown_index_incremental[copilot]
- owner: senior-dev-review
- reason: Same class — the `copilot` harness CLI is not installed on this host, so the worker never spawns.
- evidence: `Failed: Timeout (>30.0s) from pytest-timeout.` Backend log from the same run:
  `AgenticProcess … start_pty error: Command not found: 'copilot' — no harness.copilot.cli installation discovered`.
  `command -v copilot` → not installed.
- why senior review: The `[copilot]` parametrization has no install gate at all, so on a host without
  copilot it does not skip — it burns its full 30s budget and fails. Whether the fix is "provision
  copilot on QA hosts" or "gate the parametrization on discovery" is the same policy call as above.
- recommendation: Gate the per-harness parametrizations on capability discovery
  (`AgenticProcess.is_installed(<worker>)`) so an absent CLI skips explicitly and visibly, AND
  provision the harnesses on the QA host so the coverage is actually exercised. The timeout stays 30s.

## phase3/long_tests/test_prompt_queue_integration.py::test_prompt_queue_drains_into_worker[headless]
- owner: senior-dev-review
- reason: Bounded RCA effort exhausted. A real, reproducible defect distinct from the `[pty]` one that
  was fixed this cycle; it is masked as a "skip" by a tier-wide hook (see the next flag).
- evidence:
  - Reproduces deterministically. With the masking hook gated off:
    `TimeoutError: stream_transcript: transcript file did not appear within timeout`
    (`flow_sdk/builtin/agentic_process/agentic_process.py:3367`).
  - NOT an Anthropic API problem, despite the skip text saying so. Minimal repro crossing only that
    boundary: `claude -p "…" --model haiku` answered correctly in **4.088s** on this host.
  - The worker really runs: the run creates a fresh Claude project dir
    `~/.claude/projects/-tmp-flowpad-temp-pytest-*-tmp-test-prompt-queue-drains-into-0/` containing a
    populated `<uuid>.jsonl` (24 KB). So the transcript EXISTS on disk and
    `driver.transcript_path(process)` still fails to resolve to it.
  - The sibling `[pty]` variant, which was failing the same way, is now GREEN after this cycle's
    `start_pty` identity write-back fix — so the headless path has a second, independent root.
- why senior review: The remaining defect is in how the **headless / print-mode** drain binds a
  process to the session id Claude actually used. Establishing that binding correctly is a
  driver-contract question (who mints the session id for print mode, and when the process adopts the
  vendor's real id) — a design decision, not a local patch.
- recommendation: Trace `_maybe_drain_queue` → `prompt()` → the print-mode driver and confirm whether
  the process's `session_id` is ever reconciled with the id in the JSONL Claude actually wrote. Then
  fix the adoption, and drop the module from the masking hook's reach so it can never re-hide.

## phase3/harness/tests/long_tests/conftest.py::pytest_runtest_makereport — blanket TimeoutError → "skip"
- owner: senior-dev-review
- reason: Integrity defect in the test tier itself. Fixing it is a tier-wide policy change
  (an unknown number of currently-"skipped" long tests would become failures), which is exactly the
  architectural-change stop rule.
- evidence: `tests/long_tests/conftest.py:255-260` downgrades **any** `TimeoutError` /
  `ApiErrorTimeoutError` in **any** long test to a skip labelled
  `"Skipped: Anthropic API issue — {exc}"`. This cycle proved that label false at least once: the
  prompt-queue headless failure is a local transcript-binding bug, while the real Anthropic round trip
  measured 4.088s. The mask is why Phase 3 reported this tier as `1 passed, 1 skipped` instead of red.
- why senior review: This violates two run-integrity rules at once — an infra-skip is being counted as
  a non-failure, and a failure is attributed across a service boundary with no reproduction. But
  removing the downgrade will turn every currently-masked timeout red at once; someone has to own that
  backlog before the switch is flipped.
- recommendation: Replace the blanket downgrade with an explicit, per-test opt-in marker
  (e.g. `@pytest.mark.external_api_flaky`) so a test must *declare* that its timeout is an external
  dependency. Then run the tier once with the downgrade off to size the real backlog.
