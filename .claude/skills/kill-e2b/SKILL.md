---
id: b23b6410-d026-4740-a567-23053bbceaa6
name: kill-e2b
description: Kill running E2B sandboxes, filtered by the metadata the hub stamps on them (environment, size). Use when asked to kill/stop/clean up/tear down e2b boxes or sandboxes, to clear out staging or dev boxes before a test run, to free sandbox capacity, or when leftover boxes are burning credits. Defaults to environment=staging and dev, and refuses to touch production unless it is named and confirmed.
tags:
- e2b
- sandbox
- cleanup
- staging
---

# Kill E2B sandboxes

Sandboxes outlive the test that made them: they pause when idle rather than
dying, so a day of testing leaves a pile of billable boxes nobody is in.

Run the script. It is the whole skill — do not hand-roll `curl` against the E2B
API, because the parts that are easy to get wrong (finding the key, telling a
staging box from a production one) are exactly the parts already solved here.

```bash
.claude/skills/kill-e2b/scripts/e2b.py list                     # always look first
.claude/skills/kill-e2b/scripts/e2b.py kill                     # default: environment=staging,dev
.claude/skills/kill-e2b/scripts/e2b.py kill environment=staging # or any metadata key
.claude/skills/kill-e2b/scripts/e2b.py kill size=lg
```

**Filter on metadata, never on ids or names.** Every box the hub provisions is
stamped `{"environment": <deploy_env>, "size": …}` (`e2b_provider.create_node`).
That stamp is the only thing that distinguishes a staging box from a production
one — the sandbox id is opaque, and the name the hub knows it by is never sent
to the provider at all. Filters take comma-separated values (`environment=staging,dev`)
and combine with AND across keys.

**List before killing, and show the user the list.** These are other people's
running machines as often as your own; a box started ten minutes ago probably
has someone in it. The kill path prints what it matched before deleting and
what survived afterwards, so the blast radius is visible on both sides.

**Production is opt-in.** A filter matching `production` refuses unless
`FORCE_PRODUCTION=1` is set. Deliberate friction: the default and the dangerous
case differ by one word, and that word is easy to type by accident.

Killed boxes are gone, not paused — anything unsaved inside them goes with
them, which is why the look above is worth the extra breath. A run reads:

```
killing (filter: environment=staging):
total: 2
  ilkg1lojdx2mqgaw64fjz    env=staging      size=sm   started=2026-08-12T08:22:54
  iw47pp2opcjgmniq8ltvi    env=staging      size=sm   started=2026-08-12T07:26:16
  ilkg1lojdx2mqgaw64fjz -> 204
  iw47pp2opcjgmniq8ltvi -> 204
remaining:
total: 1
  i6j6wf1zvpjpn2xk15yoc    env=production   size=sm   started=2026-08-12T07:48:34
```

`204` is success. Report the survivors, not just the kills — "only production
is left" is the sentence the user actually wants.

## The api key

Resolved automatically: `E2B_API_KEY` if you have it exported, otherwise read
off the running staging hub's `.env.local` (`e2b_api_key=`, lowercase). It is
never printed — it is a live credential for every sandbox in the account,
including production.

Reading it from the VM needs `gcloud`. If that fails with a reauth error, the
script says so; ask the user to run `! gcloud auth login` themselves, since it
opens a browser and cannot be done for them.
