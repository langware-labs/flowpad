---
id: 1d1f0dc3-d8b8-496b-977d-2cc1d785ae3f
---

# 0.2.158 — the open slot

This directory is the next UNRELEASED recipe version: the only place a new
migration can be added and still be reached.

`run_if_needed` resolves a recipe under the RUNNING version's own directory, so
a recipe committed after its version was built is never found by any install —
that version is gone and every later release looks under its own directory. A
migration written here ships in the 0.2.158 wheel and runs on upgrade to it.

The directory carries no `scripts/migrate.py` yet, and `_resolve_recipe`
returns None for that — "nothing to do for this version", which is correct
until a migration is actually written. Add one as `scripts/migrate.py` with a
`run()` entry point; see `../0.2.157/scripts/migrate.py`.

## When this version is released

An EMPTY slot must not survive its own release. `_recipe_versions()` lists
directories, so once 0.2.158 ships, a slot with no `scripts/migrate.py` reads
as a recipe that was never carried by its own wheel — i.e. stranded — and
`test_no_recipe_is_stranded` fails. That is exactly what happened to the 0.2.157
slot: it was cut as a release before any migration was written into it.

So the bump must do both: DELETE this directory if it is still empty, and open
the next one. If a migration was written here, keep it — it shipped — and just
open the next slot.
