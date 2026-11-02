# ui/tests/hub - how to run

**What**: ~39 two-client hub tests (share, conversations, skills, tasks, vibe, matrix...). Tier: TWO LAUNCHED INSTANCES (alice/bob) + a hub; one realm per instance in a single process (`_instances.ts`). Also the `hub-paired` project: two-PROCESS halves that only pass when run concurrently (`matrix.alice/bob`, `conversation_messages` + `.bob`, `rename.alice/bob`) via `scripts/run_hub_paired.sh`. The plain `hub` project excludes those. See `CLAUDE.md`.

## Prerequisites
- A hub (`FLOWPAD_HUB_URL`, usually a local one) with two users.
- Two instances launched from this checkout: `scripts/instance_ctl.sh launch <a>` and `... launch <b>`. For each: generated `.env.<name>.local`, launcher registry (`launcher.json`), canonical hub, credentials, and BOTH launcher PIDs live.
- Identities by name: `ALICE_EMAIL`, `ALICE_PW` (for `SHARE_INST_1`), `BOB_EMAIL`, `BOB_PW` (for `SHARE_INST_2`).
- `uv` on PATH for tests that spawn `flow asset install`.

## Commands (from `ui/`)
```bash
export FLOWPAD_HUB_URL=<hub> SHARE_INST_1=<a> SHARE_INST_2=<b> ALICE_EMAIL=... ALICE_PW=... BOB_EMAIL=... BOB_PW=...
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<a> npm run test:vitest:hub                       # --bail 1
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<a> npx vitest run --project hub --no-file-parallelism   # no bail
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<a> npx vitest run --project hub course_project_share    # one file by name filter
env -u LOCAL_SERVER_PORT FLOW_INSTANCE=<a> npx vitest run --project hub tests/hub/<file> -t "name"
# paired halves, from the repo root; FLOW_INSTANCE must equal one pair member:
FLOW_INSTANCE=<a> scripts/run_hub_paired.sh
```

## Env vars
`FLOW_INSTANCE`, `SHARE_INST_1`, `SHARE_INST_2`, `ALICE_EMAIL/ALICE_PW`, `BOB_EMAIL/BOB_PW`, `FLOWPAD_HUB_URL`, `FLOW_HOME`; unset `LOCAL_SERVER_PORT`.

## Pitfalls
- Fails CLOSED (throws in `_setup.ts`) unless SHARE_INST_1 != SHARE_INST_2, FLOW_INSTANCE equals one of them, all four identity vars are set, and the launcher state is live. A throw is an infrastructure gap, not a test failure.
- A second instance logged into the hub as the WRONG user makes the pair fail: redo the cloud login for that instance.
- `unset LOCAL_SERVER_PORT`: it out-ranks the instance's port.
- Backends do not hot-reload: relaunch both instances after changing `flow_sdk`, or a test passes for the wrong reasons.
- Running a paired half in the plain project hangs (alice waits for a bob that never starts); use the script.
- Hub UI (`*.ui.test.ts`) tests drive a dev frontend that can take ~40 s to render the task editor on a slow host; do not shrink waits.
- `--bail 1` in the npm script (see Common). Test timeout 30 s, hook 15 s.
- Disposable instances and users only, never prod.

## Common (all vitest projects)

- Run from `ui/`: `cd ui && npm ci` first (Node 22+; the headless/hub tiers use Node's global WebSocket).
- Projects are defined in `ui/vitest.config.ts`. Run one with `npm run test:vitest:<project>` or `npx vitest run --project <name>`.
- **Every `npm run test:vitest:*` script passes `--bail 1`**: after the first failure the remaining files are SKIPPED. For real results rerun without bail: `npx vitest run --project <name> --no-file-parallelism`.
- Never raise a committed timeout. `ui/tests/adjustableTimeout.ts` (`adjusted()`) and ADJUSTABLE_TIMEOUT, if present on your branch, ADD seconds / scale caps on slow hosts: a pass under a scaled budget is not a default-budget pass.
- `uv` must be on PATH for tests that spawn `flow asset install`.

## Time
Whole project: 30+ min. Single file: 1-5 min.
