---
id: 1e4655ac-971c-4320-9a6d-f02c9309c2fa
---

# 0.2.157 — the open slot

This directory is the next UNRELEASED recipe version: the only place a new
migration can be added and still be reached.

`run_if_needed` resolves a recipe under the RUNNING version's own directory, so
a recipe committed after its version was built is never found by any install —
that version is gone and every later release looks under its own directory. A
migration written here ships in the 0.2.157 wheel and runs on upgrade to it.

The directory carries no `scripts/migrate.py` yet, and `_resolve_recipe`
returns None for that — "nothing to do for this version", which is correct
until a migration is actually written. Add one as `scripts/migrate.py` with a
`run()` entry point; see `../0.2.156/scripts/migrate.py`.

When 0.2.157 is released, the bump consumes this slot and the next one must be
opened, or `test_an_unreleased_recipe_exists_to_add_migrations_to` fails.
