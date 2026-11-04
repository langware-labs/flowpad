# ui/tests/headless - how to run

**What**: the full app (`RouterProvider` from `@src/router`) booted in jsdom + React Testing Library against a LIVE backend, no mocks. Tier: live backend (the in-process E2E tier). See `CLAUDE.md` in this folder.

## Prerequisites
- A launched, DISPOSABLE instance: `scripts/instance_ctl.sh launch <name>`. `_backend.ts` requires `.env.<name>.local`, `launcher.json` (name, ports, live backend PID) and a ready bootstrap to agree. No fallback to `.env.local` or a dev instance: otherwise the suite fails.
- Optional Claude-home isolation: launch and run with the same `FLOWPAD_CLAUDE_HOME` and `CLAUDE_CONFIG_DIR`.

## Commands (from `ui/`)
```bash
FLOW_INSTANCE=<name> npm run test:vitest:headless                 # --bail 1 --no-file-parallelism
FLOW_INSTANCE=<name> npx vitest run --project headless --no-file-parallelism   # no bail
FLOW_INSTANCE=<name> npx vitest run --project headless tests/headless/full_app_smoke.test.tsx
FLOW_INSTANCE=<name> npx vitest run --project headless tests/headless/full_app_smoke.test.tsx -t "name"
```

## Env vars
`FLOW_INSTANCE` (required), `FLOW_HOME`, `FLOWPAD_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`.

## Pitfalls
- Disposable backend only, never prod; kill only the instance this run launched.
- `unset LOCAL_SERVER_PORT` first (it out-ranks the instance's port).
- All files share ONE writable backend, hence `--no-file-parallelism` and `pool: forks`; keep it.
- jsdom ceiling: xterm terminals, Excalidraw canvas, geometry are out of scope (use Playwright).
- `--bail 1` in the npm script (see Common). A missing/mismatched instance fails the suite on purpose; that is not a pass.
- Test/hook timeout 30 s (config says do not increase without approval).

## Common (all vitest projects)

- Run from `ui/`: `cd ui && npm ci` first (Node 22+; the headless/hub tiers use Node's global WebSocket).
- Projects are defined in `ui/vitest.config.ts`. Run one with `npm run test:vitest:<project>` or `npx vitest run --project <name>`.
- **Every `npm run test:vitest:*` script passes `--bail 1`**: after the first failure the remaining files are SKIPPED. For real results rerun without bail: `npx vitest run --project <name> --no-file-parallelism`.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Never raise a committed speed budget either. On a slower host set `ADJUSTABLE_PERF_FACTOR=<factor>`: `adjustedBudget(ms)` in `ui/tests/adjustableTimeout.ts` MULTIPLIES every perf budget by it (`tab_switch_perf`). Default 1 = the committed values. A pass under a factor above 1 is not a default-budget pass: say so when reporting.
- `uv` must be on PATH for tests that spawn `flow asset install`.

## Time
Minutes to tens of minutes.
