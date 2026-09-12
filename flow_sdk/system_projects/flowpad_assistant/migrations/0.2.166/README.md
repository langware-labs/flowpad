---
id: 05145eb3-1db4-43d5-aed7-07e3c5668592
---

# 0.2.166 — the open slot

This directory is the next UNRELEASED recipe version: the only place a new
migration can be added and still be reached. It is created by the release
script when 0.2.165 is cut; do not hand-author it.

`run_if_needed` resolves a recipe under the RUNNING version's own directory,
so a recipe committed after its version was built is never found by any install
— that version is gone, and every later release looks under its own directory.
A migration written here ships in the 0.2.166 wheel and runs on upgrade to it.

Add one as `scripts/migrate.py` with a `run()` entry point, or as
`skill/SKILL.md` for an agent-driven recipe. Until then `_resolve_recipe`
returns None for this version — "nothing to do" — which is correct.

If this slot is still empty when 0.2.166 is released, the release script
deletes it rather than shipping a directory with no recipe in it.
