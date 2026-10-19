"""0.2.155 — the reachable home for the next migration. Does nothing yet.

``run_if_needed`` resolves a recipe under the RUNNING version's own directory,
so a recipe is only ever reached by installs of the version it ships in. A
migration written under an ALREADY-RELEASED version is therefore stranded on
arrival: that version's wheel is built and no install will ever be it again.

The only reachable place to add one is a version that has not been released
yet, which means the tree must always carry an unreleased recipe directory.
0.2.154 was that directory until this branch's bump commit released it, leaving
none -- exactly the state `test_an_unreleased_recipe_exists_to_add_migrations_to`
exists to catch. This is the next one, opened so the rule does not forbid
writing a migration at all.

Empty on purpose. The launch path stays instant (see 0.2.153 for why that
matters), and the stranded debt stays declared in 0.2.153's ``STRANDED``.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    """No work yet — put the next migration's body here."""
    return {}
