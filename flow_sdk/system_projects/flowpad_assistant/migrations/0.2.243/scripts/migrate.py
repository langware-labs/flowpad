"""0.2.243: consolidate local authorization roles and cached role sets."""

import json

from flow_sdk.migrations.migration_2026_10_role_sets import migrate


def run():
    report = migrate(dry_run=False)
    print(json.dumps(report))  # noqa: T201 - migration runner report
    if report["errors"]:
        raise RuntimeError("Role migration blocked by unknown roles; no changes were applied")
    return report
