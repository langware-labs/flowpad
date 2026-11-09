# ui/tests/react - how to run

**What**: 123 files of React component/hook tests with Testing Library in jsdom (`reactSetup.ts`). Tier: LIVE LOCAL BACKEND: some suites use the real SDK and write entities and host files, and `reactSetup.ts` refuses to run without a matching backend.

## Prerequisites
`cd ui && npm ci`. A running DISPOSABLE backend: `scripts/instance_ctl.sh launch <name>` from this checkout. No credentials.

## Commands (from `ui/`)
```bash
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npm run test:vitest:react
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project react --no-file-parallelism   # no bail
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project react tests/react/message-run-status-counters.test.tsx
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project react tests/react/message-run-status-counters.test.tsx -t "name"
```

## Env vars
`FLOW_INSTANCE` (required) names the launcher-owned backend. Its `.env.<name>.local`, launcher registry, port and backend PID must all agree, or setup throws before any test runs. `LOCAL_SERVER_PORT`: unset it, a value in the shell overrides the env file.

## Pitfalls
- `--bail 1` in the npm script (see Common).
- jsdom has no layout: do not assert geometry here.
- React/router/query are deduped and inlined by config; a second copy of React in a new import shows up as hook errors.
- Test/hook timeout 15 s; do not raise.

## Common (all vitest projects)

- Run from `ui/`: `cd ui && npm ci` first (Node 22+; the headless/hub tiers use Node's global WebSocket).
- Projects are defined in `ui/vitest.config.ts`. Run one with `npm run test:vitest:<project>` or `npx vitest run --project <name>`.
- **Every `npm run test:vitest:*` script passes `--bail 1`**: after the first failure the remaining files are SKIPPED. For real results rerun without bail: `npx vitest run --project <name> --no-file-parallelism`.
- Never raise a committed timeout. `ui/tests/adjustableTimeout.ts` (`adjusted()`) and ADJUSTABLE_TIMEOUT, if present on your branch, ADD seconds / scale caps on slow hosts: a pass under a scaled budget is not a default-budget pass.
- `uv` must be on PATH for tests that spawn `flow asset install`.

## Time
A few minutes.
