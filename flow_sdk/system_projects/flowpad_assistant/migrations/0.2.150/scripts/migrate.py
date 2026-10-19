"""Collapse duplicated data source definitions onto one row per name.

Entry point: ``run()``. The runner calls it with no args, once, on upgrade.
Idempotent — a clean instance reports nothing to collapse.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_data_source_spec_name_identity import collapse

    report = collapse(dry_run=False)
    summary = {"rows_deleted": report.rows_deleted, "rows_rekeyed": report.rows_rekeyed}
    if not report.groups:
        print("data source specs: one row per name already.")  # noqa: T201 — migration output is user-facing
        return summary
    print(  # noqa: T201
        f"data source specs: removed {report.rows_deleted} duplicate row(s), "
        f"re-keyed {report.rows_rekeyed} — the provider picker lists each source once."
    )
    for group in report.groups:
        if group.losers:
            print(f"  {group.name}: -{len(group.losers)}")  # noqa: T201
    return summary
