"""0.2.154 — every asset id in its live carrier form, ``asset_ref`` at the root.

Runs ``flow_sdk.migrations.migration_2026_09_identity_live_forms`` once on
upgrade: the retired id forms (comment capsule, ``asset_id:``, ``.flow/id``,
manifest id) are moved into the live carriers, id unchanged, and every folder
row's ``asset_ref`` is rewritten to its folder. The readers of the retired
forms are deleted in the release after this one, which is why this must have
run on every instance first. Idempotent — a converted instance reports zeros.

``run_if_needed`` resolves a recipe under the RUNNING version's own directory,
so a recipe is only ever reached by installs of the version it ships in; the
next migration opens the next unreleased directory.

Entry point: ``run()``.
"""

from __future__ import annotations

import asyncio


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_identity_live_forms import migrate

    # The runner calls ``run()`` from inside its own event loop, so a bare
    # ``asyncio.run`` would raise. Hand the coroutine to a worker thread when
    # a loop is already running; call it directly when it isn't.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        report = asyncio.run(migrate(dry_run=False))
    else:
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            report = pool.submit(lambda: asyncio.run(migrate(dry_run=False))).result()

    summary = {
        "sources_converted": sum(report.converted.values()),
        "sources_left_retired": sum(report.unconverted.values()),
        "rows_rewritten": report.rows_rewritten,
        "scan_issues": len(report.issues),
    }
    if not report.changed:
        print("identity: every id already in its live form; every asset_ref at its root.")  # noqa: T201 — migration output is user-facing
        return summary
    print(  # noqa: T201
        f"identity: converted {summary['sources_converted']} source(s) "
        f"{dict(report.converted)}, rewrote {report.rows_rewritten} asset_ref row(s)."
    )
    for form, count in report.unconverted.items():
        print(f"  still {form}: {count} (read-only or not this row's id)")  # noqa: T201
    return summary
