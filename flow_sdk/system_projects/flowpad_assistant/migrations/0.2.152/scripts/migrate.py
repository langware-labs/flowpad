"""0.2.152 — the new auto-bookmark repair, plus every migration that never ran.

TWO jobs, and the second one is the bigger surprise.

**The catch-up.** ``run_if_needed`` resolves a recipe under the RUNNING version's
own directory and silently returns 0 when there is none, so a recipe committed
after its version was built is unreachable forever — no install will ever be
that version again, and every later release looks under its own directory.
``0.2.95``, ``0.2.103``, ``0.2.112``, ``0.2.121``, ``0.2.137`` and ``0.2.150``
were each written after their release shipped (mostly the day after the bump
commit), so NONE of them has ever run on any install — which is why
``<flow_home>/global/migrations`` is empty on machines that have been upgrading
for months. They are re-driven from here, in version order, so the debt finally
clears. See ``tests/unit/test_migration_recipes_ship_with_their_version.py``,
which fails if a future recipe repeats the mistake.

**The new one.** Collapse duplicated ``flow show`` auto-bookmark trees, so each
project has a single "Auto" favorites folder.

Catch-up steps are BEST-EFFORT and can never block a launch: a failure in
``_start_service_guarded`` refuses to start the server, and a five-releases-old
whiteboard move hitting a permission error must not brick an install. Each is
independent and idempotent, so one failing leaves the others' work valid; the
failure is printed where the user sees it on start. The migration this version
is actually FOR is strict — it raises, exactly as any other version's would.

Entry point: ``run()``.
"""

from __future__ import annotations

from pathlib import Path

#: Recipes that were never in their own wheel, oldest first — the order history
#: would have applied them in.
STRANDED = ("0.2.95", "0.2.103", "0.2.112", "0.2.121", "0.2.137", "0.2.150")

_RECIPES = Path(__file__).resolve().parents[2]


def _run_recipe(version: str) -> None:
    """Execute a sibling version's ``run()``, through the same by-path loader
    the runner uses on this very script."""
    from flow_sdk.migrations.runner import load_script_module

    script = _RECIPES / version / "scripts" / "migrate.py"
    if not script.is_file():
        print(f"  {version}: recipe missing, skipped")  # noqa: T201 — migration output is user-facing
        return
    with load_script_module(f"_flowpad_catchup_{version.replace('.', '_')}", script) as module:
        module.run()


def _catch_up() -> int:
    """Re-drive the stranded recipes. Returns how many failed."""
    print("Catching up migrations that never shipped in their own release:")  # noqa: T201
    failed = 0
    for version in STRANDED:
        print(f"── {version}")  # noqa: T201
        try:
            _run_recipe(version)
        except Exception as e:  # noqa: BLE001 — best-effort by design, see module docstring
            failed += 1
            print(f"  {version} FAILED: {type(e).__name__}: {e}")  # noqa: T201
    return failed


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_auto_favorite_duplicate_roots import dedupe

    failed = _catch_up()
    if failed:
        print(  # noqa: T201
            f"{failed} catch-up migration(s) failed; they will be retried on the next "
            "upgrade that carries them. Startup continues."
        )

    report = dedupe(dry_run=False)
    summary = {
        "rows_deleted": report.rows_deleted,
        "rows_reparented": report.rows_reparented,
        "catch_up_failed": failed,
    }
    if not report.groups:
        print("auto bookmarks: one Auto tree per project already.")  # noqa: T201
    else:
        print(  # noqa: T201
            f"auto bookmarks: removed {report.rows_deleted} duplicate row(s), "
            f"re-filed {report.rows_reparented} — each project has one 'Auto' folder."
        )
        for line in report.groups:
            print(f"  {line}")  # noqa: T201
    for line in report.unscoped_trees:
        print(f"  legacy unscoped tree: {line}")  # noqa: T201
    return summary
