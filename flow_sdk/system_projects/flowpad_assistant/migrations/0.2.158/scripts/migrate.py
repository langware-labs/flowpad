"""0.2.158 — the reachable home for the next migration. Does nothing yet.

``run_if_needed`` resolves a recipe under the RUNNING version's own directory,
so a recipe is only ever reached by installs of the version it ships in. A
migration written under an ALREADY-RELEASED version is therefore stranded on
arrival: that version's wheel is built and no install will ever be it again.

The only reachable place to add one is a version that has not been released
yet, which means the tree must always carry an unreleased recipe directory.
Right after a release bump there is none — every directory names a shipped
version — and `test_an_unreleased_recipe_exists_to_add_migrations_to` fails
until someone opens the next one. 0.2.157 was bumped without opening one;
this is that directory.

Empty on purpose. The launch path stays instant (see 0.2.153 for why that
matters).

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    """No work yet — put the next migration's body here."""
    return {}
