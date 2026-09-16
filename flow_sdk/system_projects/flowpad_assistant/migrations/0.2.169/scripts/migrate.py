"""0.2.169 — every ingested record carries its origin; every projected message its row's; every
agent is an entity document (``agent.json`` + ``system_prompt.md``); every data source asset lives in
``agentic-assets/data_driver/<name>/data_driver.json``.

Runs ``flow_sdk.migrations.migration_2026_09_sources_cutover`` and then
``flow_sdk.migrations.migration_2026_09_entity_json_mains`` once on upgrade. Without the first the
ingestor, which now resolves rows by their origin, would miss every record ingested before this
release and mint a twin of each on the next poll. Without the second an agent still in ``agent.md``
is reported by the scan and never indexed. Both are idempotent — a converted instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_data_driver_rename import migrate as migrate_driver_type
    from flow_sdk.migrations.migration_2026_09_entity_json_mains import migrate as migrate_entity_documents
    from flow_sdk.migrations.migration_2026_09_retired_asset_forms import migrate as migrate_retired_forms
    from flow_sdk.migrations.migration_2026_09_sources_cutover import migrate

    # FIRST: the cutover below looks configured sources up by their type string, which is now
    # ``data_driver``. Run it against unrenamed rows and it finds none, so every record is unliftable.
    renamed = migrate_driver_type(dry_run=False)
    print(renamed.summary())  # noqa: T201 — migration output is user-facing

    report = migrate(dry_run=False)
    summary = {
        "driver_rows_renamed": renamed.rows,
        "driver_shadows_moved": renamed.shadows_moved,
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

    forms = migrate_retired_forms(dry_run=False)
    summary.update({
        "retired_folders_moved": forms.moved,
        "retired_mains_renamed": forms.renamed,
        "retired_form_conflicts": len(forms.conflicts),
    })
    print(forms.summary())  # noqa: T201
    return summary
