# ui/tests/api - how to run

**What**: ~74 SDK-to-backend API tests (compute nodes, shell runs, projects, skills...). Tier: LIVE BACKEND over HTTP/WebSocket (jsdom client, `pool: forks`). Writes real entities (cleaned up by `tests/_cleanup.ts`).

## Prerequisites
- A running DISPOSABLE backend: `scripts/instance_ctl.sh launch <name>` from this checkout. The config derives the port from `LOCAL_SERVER_PORT` in `.env.$FLOW_INSTANCE.local`, default 9007 when no instance is selected.
- `FLOWPAD_CLAUDE_HOME` and `CLAUDE_CONFIG_DIR` must resolve to the SAME directory (setup throws otherwise); set both to a cycle-owned dir for isolation, also when launching the instance.
- `cd ui && npm ci`.

## Commands (from `ui/`)
```bash
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npm run test:vitest:api          # --bail 1 --no-file-parallelism
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project api --no-file-parallelism   # no bail
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project api tests/api/shell_run_command.test.ts
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<name> npx vitest run --project api tests/api/shell_run_command.test.ts -t "name"
```

## Env vars
`FLOW_INSTANCE`, `LOCAL_SERVER_PORT` (unset it), `FLOWPAD_CLAUDE_HOME` + `CLAUDE_CONFIG_DIR`, `FLOW_HOME`.

## Pitfalls
- Unset `LOCAL_SERVER_PORT` before runs: a Flowpad shell exports the prod backend port and it out-ranks the instance's own port.
- Never point it at prod or a user-owned instance; skills/entities are really created.
- Backends do not hot-reload: relaunch the instance after changing `flow_sdk`.
- `--bail 1` in the npm script (see Common).
- Tests run serially (shared writable backend); do not enable file parallelism.
- Some files spawn real workers; they need CLI sign-in/onboarding and an LLM credential, else they stall or fail (report as missing credential).

## Common (all vitest projects)

- Run from `ui/`: `cd ui && npm ci` first (Node 22+; the headless/hub tiers use Node's global WebSocket).
- Projects are defined in `ui/vitest.config.ts`. Run one with `npm run test:vitest:<project>` or `npx vitest run --project <name>`.
- **Every `npm run test:vitest:*` script passes `--bail 1`**: after the first failure the remaining files are SKIPPED. For real results rerun without bail: `npx vitest run --project <name> --no-file-parallelism`.
- Never raise a committed timeout. `ui/tests/adjustableTimeout.ts` (`adjusted()`) and ADJUSTABLE_TIMEOUT, if present on your branch, ADD seconds / scale caps on slow hosts: a pass under a scaled budget is not a default-budget pass.
- `uv` must be on PATH for tests that spawn `flow asset install`.

## Time
10-30 min for the project; test/hook timeout 15 s.
