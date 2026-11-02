# ui/tests/long_tests - how to run

**What**: ~30 real-worker tests: Claude/Codex PTY turns, PTY recovery after backend restart, embedded assets, e2b sandbox, system skills. Tier: LIVE BACKEND + real LLM + real CLIs (project `long`; includes `tests/api` files too per its config).

## Prerequisites
- Disposable backend/instance (see `ui/tests/api/RUN.md`); restart/recovery tests launch their own via `scripts/instance_ctl.sh` (`_backend_lifecycle.ts`).
- The worker CLI installed, signed in AND onboarded (a fresh config without `hasCompletedOnboarding`/trust dialog stalls) plus an LLM credential. A missing credential is reported as missing, not fixed.
- `FLOWPAD_CLAUDE_HOME` = `CLAUDE_CONFIG_DIR` (api setup throws otherwise).

## Commands (from `ui/`)
```bash
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npm run test:vitest:long            # --bail 1
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project long --no-file-parallelism   # no bail
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project long tests/long_tests/classify_session.test.ts
FLOW_INSTANCE=<name> npm run test:vitest:long:claude       # also :codex, :deepagents (set FLOWPAD_DEFAULT_WORKER)
RUN_PTY_STRESS=1 ... npx vitest run --project long tests/long_tests/pty_launch_under_load.test.ts   # stress files
```

## Env vars
`FLOW_INSTANCE`, `FLOWPAD_DEFAULT_WORKER`, `RUN_PTY_STRESS`, `FLOWPAD_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`, `FLOW_HOME`, LLM credential names per file (e.g. `OPENROUTER_API_KEY`).

## Pitfalls
- Stress/timing files (`stressDescribe`) are skipped unless `RUN_PTY_STRESS=1`; they spawn 20-80 real PTYs and only pass on a host with spare capacity. Do not loosen their budgets.
- Unset `LOCAL_SERVER_PORT`; backends do not hot-reload.
- Disposable instance only: tests create entities and spawn real agents.
- `--bail 1` in the npm script (see Common).
- Do not `pkill -f run_hub` from the test shell.

## Time
Per-test timeout 240 s (config), hook 15 s. Whole project: 30-90 min.
