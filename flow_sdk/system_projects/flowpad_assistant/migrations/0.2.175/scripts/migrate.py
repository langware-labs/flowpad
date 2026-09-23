"""0.2.175 — message attachment bytes move out of the OS temp dir.

Runs ``flow_sdk.migrations.migration_2026_09_embedded_storage_to_record_data``
once on upgrade: every message's FILE / PROMPT-file bytes are copied into its
record-data folder from the unpacked bundle or the old OS-temp root, before the
next reboot empties that root. Idempotent — a migrated instance reports only
``present``.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_embedded_storage_to_record_data import migrate

    counts = migrate(dry_run=False)
    print(  # noqa: T201 — migration output is user-facing
        f"attachments: {counts['restored']} restored, {counts['present']} already home, "
        f"{counts['unrecoverable']} unrecoverable (re-download from the conversation)."
    )
    return counts
