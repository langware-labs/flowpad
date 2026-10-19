"""0.2.153 — no work on start, and the stranded debt stays declared.

**Why this recipe does nothing.** 0.2.152 re-drove six never-shipped recipes at
launch. On a real install that took **249s**, during which `flow start` binds no
port and prints no progress — indistinguishable from a hang. It is also not
resumable: interrupting it leaves an orphaned attempt, and the next start begins
the whole 4 minutes again (``Previous attempt … appears orphaned … retrying
best-effort``), so an impatient user loops and never gets a server. Users were
failing on exactly that.

So the launch path is empty again. ``run_if_needed`` resolves a recipe under the
RUNNING version's own directory, so an install on 0.2.153 does none of that work
and starts immediately — including one stuck part-way through 0.2.152's attempt.

**The debt is not forgotten.** ``STRANDED`` still names every recipe that never
shipped in its own wheel, which is what
``tests/unit/test_migration_recipes_ship_with_their_version.py`` reads: the
history stays declared and the guard keeps failing if a future recipe repeats
the mistake. Repaying it needs two things this version does not have — a
progress signal, and resumability — and belongs in an explicit maintenance
command, never on a user's launch path.

Entry point: ``run()``.
"""

from __future__ import annotations

#: Recipes that were never in their own wheel, oldest first. DECLARED, not
#: re-driven — see the module docstring. Keep this list accurate: the guard test
#: compares it against the versions it computes from git history.
STRANDED = ("0.2.95", "0.2.103", "0.2.112", "0.2.121", "0.2.137", "0.2.150")


def run() -> dict[str, int]:
    """Deliberately a no-op, so start is instant."""
    return {"rows_deleted": 0, "rows_reparented": 0, "catch_up_failed": 0}
