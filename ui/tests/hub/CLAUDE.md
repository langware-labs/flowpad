---
id: 9dc7515b-c126-564f-9a27-4884c0b45b6a
---

# Hub tests

Multi-instance vitest (two real SDK clients in one process, one realm per instance — see `_instances.ts` `getInstance`): `scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2 && (cd ui && npx vitest run --project hub skill_share_two_client)` (needs the local hub up; skips otherwise).
