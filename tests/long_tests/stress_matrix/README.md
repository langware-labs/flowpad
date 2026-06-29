---
id: 4587f11c-2081-55b6-80a9-ac5a0d1e48ef
---

# Stress matrix — headless agentic process resilience

Phase 1: prove the headless agentic process (`AgenticProcess.prompt` with
`visible=False`, routed through `ClaudeCLIStreamWorker`) survives a matrix
of substrate corruptions and either completes the turn or fails loudly with
a known error code.

Each cell:

1. Builds a clean tmpdir on the host as `/work` inside a fresh container.
2. `victimize.sh` applies the cell's specific corruption to the substrate.
3. Runs `runner_entrypoint.py` which spawns one `ClaudeCLIStreamWorker.execute()`
   turn against a trivial prompt.
4. The runner writes `_runner_complete.json` into `/work` with the turn outcome.
5. The host pytest asserts on exit code, sentinel presence, and stderr regex.

## Running

```bash
DEEP_TESTING=1 ANTHROPIC_API_KEY=sk-... pytest tests/long_tests/stress_matrix/
```

## Pre-flight

`conftest.py` validates the `ANTHROPIC_API_KEY` once per session via a
minimal `/v1/models` call. On invalid key or rate-limit the entire matrix
aborts (no cells run) with a clear stderr message — these are environment
problems, not runner-resilience signals.

## Per-cell budget

Every test is `@pytest.mark.timeout(30)`. See `feedback_test_timeout_30s` —
budget is fixed; if a cell needs longer the runner is wrong.
