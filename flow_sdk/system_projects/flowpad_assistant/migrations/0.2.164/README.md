---
id: 466ae1fb-b436-4cdd-b159-606abdfc5b2d
---

# 0.2.164 — the open slot

This directory is the next UNRELEASED recipe version: the only place a new
migration can be added and still be reached.

`run_if_needed` resolves a recipe under the RUNNING version's own directory, so
a recipe committed after its version was built is never found by any install —
that version is gone and every later release looks under its own directory. A
migration written here ships in the 0.2.164 wheel and runs on upgrade to it.

The directory carries no `scripts/migrate.py` yet, and `_resolve_recipe`
returns None for that — "nothing to do for this version", which is correct
until a migration is actually written. Add one as `scripts/migrate.py` with a
`run()` entry point, or as `skill/SKILL.md` for an agent-driven recipe.

## When this version is released

An EMPTY slot must not survive its own release. `_recipe_versions()` lists
directories, so once 0.2.164 ships, a slot with no recipe reads as one that was
never carried by its own wheel — i.e. stranded — and `test_no_recipe_is_stranded`
fails.

So the bump must do both: DELETE this directory if it is still empty, and open
the next one. If a migration was written here, keep it — it shipped — and just
open the next slot.

This slot has now been through that failure twice. The 0.2.160 one was released
empty in 83c986c27, survived its own release, and read as stranded ever after;
it was removed rather than back-filled, since an empty slot carries nothing to
run. The 0.2.163 one that replaced it went the same way — `chore(release):
0.2.163` (169271b87) shipped without advancing it, and the three guards in
`tests/unit/test_migration_recipes_ship_with_their_version.py` went red on
release/v0.2, which also blocks the e2e job behind them. It was advanced to
0.2.164 rather than back-filled, for the same reason. The bump is what has to
change: the release step must advance this slot, or the next release repeats it.
