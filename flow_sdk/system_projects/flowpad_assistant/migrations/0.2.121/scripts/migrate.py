"""Collapse forked asset rows and heal references left pointing at reaped ones.

Before the owner-first identity fix, an asset whose in-file identity capsule was
wiped by a full-content rewrite (what an agent does on every revision) got a
FRESH id on the next index, forking the entity. Two kinds of damage accumulated:

* several live rows claiming one file path, so "which entity is this document?"
  had more than one answer;
* bookmarks and display pins aimed at rows the same-path sweep had already
  reaped, which render as "Missing asset" over a file that is still on disk.

Neither self-heals: the fix stops NEW forks, it does not undo old ones.

Entry point: ``run()``. The runner calls it with no args, once, on upgrade.
Idempotent — a repaired instance yields zero groups and zero dangling refs.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


def run() -> dict[str, int]:
    """Apply the collapse to this instance's DB. Returns a small summary."""
    from flow_sdk.migrations.migration_2026_08_asset_ref_collapse import collapse

    # The runner calls ``run()`` from inside its own event loop, so a bare
    # ``asyncio.run`` would raise. Hand the coroutine to a worker thread when
    # a loop is already running; call it directly when it isn't.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        report = asyncio.run(collapse(dry_run=False))
    else:
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            report = pool.submit(lambda: asyncio.run(collapse(dry_run=False))).result()

    summary = {
        "forked_paths": report.forked_paths,
        "rows_deleted": report.rows_deleted,
        "dangling_healed": len(report.dangling),
        "files_restamped": report.files_restamped,
    }
    if not any(summary.values()):
        print("asset-ref collapse: nothing to repair.")
        return summary

    print(
        f"asset-ref collapse: {summary['forked_paths']} forked path(s) collapsed "
        f"({summary['rows_deleted']} row(s) removed), "
        f"{summary['dangling_healed']} dangling reference(s) healed, "
        f"{summary['files_restamped']} file(s) restamped."
    )
    for group in report.groups:
        print(f"  {group.type_name} {group.path}")
        print(f"    keep {group.winner} ({group.reason})")
        for loser in group.losers:
            print(f"    drop {loser}")
    for d in report.dangling:
        print(f"  {d.holder_type}/{d.holder_id}: {d.dead_id} -> {d.live_id}")
    return summary
