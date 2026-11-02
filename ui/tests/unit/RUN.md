# ui/tests/unit - how to run

**What**: ~980 test files of UI/SDK logic and components (jsdom). Tier: mock; the config defines `__API_URL__` as an unreachable `.invalid` host, so there is no backend, hub, or LLM.

## Prerequisites
`cd ui && npm ci`. No credentials.

## Commands (from `ui/`)
```bash
npm run test:vitest:unit                                          # whole project, --bail 1
npx vitest run --project unit --no-file-parallelism               # no bail: full result
npx vitest run --project unit tests/unit/launch-runner.test.ts    # one file
npx vitest run --project unit tests/unit/launch-runner.test.ts -t "test name"   # one test
```

## Env vars
None required. `FLOW_INSTANCE` / `LOCAL_SERVER_PORT` are not used by this tier.

## Pitfalls
- `--bail 1` in the npm script hides everything after the first failure (see Common).
- Single thread, jsdom: no layout engine (`getBoundingClientRect` is zeros); layout/canvas bugs belong in `browser_render` Playwright specs.
- Setup files: `tests/_lingui-mock.ts`, `_restore-globals.ts`, `unit/testSetup.ts`. A test that leaks globals can break later files in the same worker; rerun the single file to tell.
- Test/hook timeout 15 s (config); do not raise.

## Common (all vitest projects)

- Run from `ui/`: `cd ui && npm ci` first (Node 22+; the headless/hub tiers use Node's global WebSocket).
- Projects are defined in `ui/vitest.config.ts`. Run one with `npm run test:vitest:<project>` or `npx vitest run --project <name>`.
- **Every `npm run test:vitest:*` script passes `--bail 1`**: after the first failure the remaining files are SKIPPED. For real results rerun without bail: `npx vitest run --project <name> --no-file-parallelism`.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- `uv` must be on PATH for tests that spawn `flow asset install`.

## Time
A few minutes for the project.
