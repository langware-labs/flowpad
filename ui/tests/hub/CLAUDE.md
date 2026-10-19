---
id: 9dc7515b-c126-564f-9a27-4884c0b45b6a
---

# Hub tests

Multi-instance vitest (two real SDK clients in one process, one realm per instance — see `_instances.ts` `getInstance`): `scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2 && (cd ui && npx vitest run --project hub skill_share_two_client)` (needs the local hub up; skips otherwise).

## The course journey (share → install → auto-launch)

`course_project_share_two_client.ui.test.ts` runs the whole recipient journey across two
instances: Alice shares a git-backed project, Bob is offered it, clicks **Install**, and the
project opens straight into its `auto_launch` agent. The origin is a LOCAL bare repo over
`file://`, so it needs no GitHub account — a `github_not_connected` refusal is a failure, not a
skip (the share gate only demands a token for GitHub origins).

```bash
scripts/instance_ctl.sh launch dev-3 && scripts/instance_ctl.sh launch dev-4
cd ui && env -u LOCAL_SERVER_PORT FLOWPAD_HUB_URL=http://localhost:8093 \
  SHARE_INST_1=dev-3 SHARE_INST_2=dev-4 \
  ALICE_EMAIL=dev-3@local.test ALICE_PW=dev-3-pw-1234 \
  BOB_EMAIL=dev-4@local.test BOB_PW=dev-4-pw-1234 \
  FLOW_INSTANCE=dev-3 npx vitest run --project hub course_project_share
```

Two traps this cost time on, both silent:

* **`env -u LOCAL_SERVER_PORT`.** A Flowpad shell exports the prod backend port, and it
  out-ranks the instance's own port in the config's env lookup — `_setup.ts` then fails closed
  before any test runs.
* **Restart the instances after touching `flow_sdk`.** Backends do not hot-reload, so a launched
  instance keeps serving the code it started with; the journey passed for the wrong reasons until
  both sides were relaunched on the new code.

`scripts/course_share_live.sh [alice] [bob]` runs this same test headed and screenshots each step
into `artifacts/course-live-<stamp>/` — the demo and the guard are one definition.
