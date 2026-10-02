"""0.2.185 — the `flow show` auto-bookmark tree is gone; remove the rows it wrote.

Runs once on upgrade:

* ``migration_2026_10_remove_auto_bookmarks`` — deletes every ``source="auto"``
  bookmark (the ``Auto / <type> / item`` folders and leaves, including leaves a
  folder delete had promoted to a project's root) and every bookmark with no
  ``bookmark_type`` (test pollution nothing renders). User-made favorites and
  folders are never touched.

Idempotent — a clean instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations import migration_2026_10_remove_auto_bookmarks

    report = migration_2026_10_remove_auto_bookmarks.migrate(dry_run=False)
    print(report.summary())  # noqa: T201 — migration output is user-facing
    return {"auto_removed": len(report.auto), "typeless_removed": len(report.typeless)}
