"""0.2.169 — every ingested record carries its origin; every projected message its row's; every
agent is an entity document (``agent.json`` + ``system_prompt.md``).

Runs ``flow_sdk.migrations.migration_2026_09_sources_cutover`` and then
``flow_sdk.migrations.migration_2026_09_entity_json_mains`` once on upgrade. Without the first the
ingestor, which now resolves rows by their origin, would miss every record ingested before this
release and mint a twin of each on the next poll. Without the second an agent still in ``agent.md``
is reported by the scan and never indexed. Both are idempotent — a converted instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_entity_json_mains import migrate as migrate_entity_documents
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
    else:
        print(  # noqa: T201
            f"sources: lifted {report.rows_lifted} record(s), removed {report.duplicates_removed} duplicate(s), "
            f"updated {report.messages_repointed + report.messages_reoriginated} message(s) "
            f"and {report.conversations_stamped} conversation(s)."
        )

    documents = migrate_entity_documents(dry_run=False)
    summary.update({
        "entity_documents_converted": sum(documents.converted.values()),
        "entity_documents_unconverted": sum(documents.unconverted.values()),
        "entity_documents_conflicts": len(documents.conflicts),
    })
    if documents.changed or documents.unconverted or documents.conflicts:
        print(  # noqa: T201
            f"agents: converted {sum(documents.converted.values())} to agent.json, "
            f"left {sum(documents.unconverted.values())}, {len(documents.conflicts)} conflict(s)."
        )
    else:
        print("agents: every agent is already an agent.json document.")  # noqa: T201
    return summary
