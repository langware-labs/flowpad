"""0.2.168 — every ingested record carries its origin; every projected message its row's.

Runs ``flow_sdk.migrations.migration_2026_09_sources_cutover`` once on upgrade. Without it
the ingestor, which now resolves rows by their origin, would miss every record ingested
before this release and mint a twin of each on the next poll. Idempotent — a converted
instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_sources_cutover import migrate

    report = migrate(dry_run=False)
    summary = {
        "rows_lifted": report.rows_lifted,
        "rows_unliftable": report.rows_unliftable,
        "duplicates_removed": report.duplicates_removed,
        "messages_repointed": report.messages_repointed,
        "messages_reoriginated": report.messages_reoriginated,
        "conversations_stamped": report.conversations_stamped,
    }
    if not report.changed:
        print("sources: every record already carries its origin.")  # noqa: T201 — migration output is user-facing
        return summary
    print(  # noqa: T201
        f"sources: lifted {report.rows_lifted} record(s), removed {report.duplicates_removed} duplicate(s), "
        f"updated {report.messages_repointed + report.messages_reoriginated} message(s) "
        f"and {report.conversations_stamped} conversation(s)."
    )
    return summary
