---
id: f5ac7c57-4581-4081-aa4e-ba9c6698ed71
title: Migration open-slot must be advanced by the release
tags:
- breadcrumb.test.migration_slot.rules
description: A release bump consumes the open recipe slot; unless the release advances
  it, the empty slot survives its own release and reads as stranded.
---

# Migration open-slot must be advanced by the release

> Ground truth. Proven by RCA on 2026-09-09. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.migration_slot.rules
sites:
  - rel_path: "tests/unit/test_migration_recipes_ship_with_their_version.py"
    line: 138
    note: "RED? The release consumed the open recipe slot. Advance it to the next unreleased version before touching this test."
```

## Expected behavior

`flow_sdk/system_projects/flowpad_assistant/migrations/` holds one directory per
recipe version, and exactly one of them names a version that has **not** shipped
— the open slot, the only reachable place a new migration can be written.
`runner._resolve_recipe(__version__)` looks only under the RUNNING version's own
directory, so a recipe committed after its version was built is never found by
any install.

## Internals

* `_recipe_versions()` (`tests/unit/test_migration_recipes_ship_with_their_version.py`)
  lists **directories**. A slot carrying no `scripts/migrate.py` is therefore
  indistinguishable from a recipe its own wheel never carried.
* `_release_commit(v)` finds the commit that set `__version__ = "<v>"` in
  `flow_sdk/_version.py`; a version with no such commit is unreleased.
* `_catch_up_coverage()` unions the module-level `STRANDED` tuples of recipes that
  did ship. The standing debt is declared in `migrations/0.2.152/scripts/migrate.py`
  and `0.2.153/scripts/migrate.py` — six versions, unchanged by this rule.

## Invariants

* At least one recipe directory names an unreleased version.
* No released version's recipe is both stranded and unnamed by a `STRANDED` tuple.
* An **empty** slot must not survive its own release: the bump deletes it if it is
  still empty and opens the next. If a migration was written there, it shipped —
  keep it and open the next slot alongside.

## Failure modes

The lever: rename `migrations/0.2.164` back to `0.2.163` and exactly these fail —
`test_no_recipe_is_stranded`, `test_the_catch_up_actually_covers_the_stranded_history`,
`test_an_unreleased_recipe_exists_to_add_migrations_to`. Advance it again and all
four pass. `test_the_resolver_finds_a_recipe_that_did_ship` is the control and
stays green throughout, so a green run means something.

`test_an_unreleased_recipe_exists_to_add_migrations_to` is the one that bites: with
every directory naming a released version there is nowhere reachable to write a new
migration at all.

**Fix when red:** advance the slot, do not back-fill. An empty slot carries nothing
to run.

**Root cause is upstream of this test.** `.claude/skills/deploy-pypi/SKILL.md` (step 3,
"bump + build + publish", writing `flow_sdk/_version.py`) and
`scripts/deploy_to_github.sh` never mention the slot, so the release cannot advance
it. That is why this has happened twice — 0.2.160 released empty in `83c986c27`, and
0.2.163 in `169271b87` (fixed on `FLOWPAD-2121`, PR #435). Until the release step
carries it, the next release repeats it.

**Knock-on:** these tests live in `backend (pytest unit)`, which gates the `e2e` job
in `.github/workflows/test.yml` (`needs:` + a per-result `if:`). While they are red
e2e is **skipped, not failed** — so this defect silently removes e2e coverage as well
as breaking migrations.
