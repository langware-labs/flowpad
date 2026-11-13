"""0.2.263: ``labels`` leaves every row and every stored tag becomes a valid one; a received data source
gives back its author's private config; saved auto-approve contact permissions are deleted."""

from flow_sdk.migrations.migration_2026_11_drop_contact_permission import migrate as drop_contact_permissions
from flow_sdk.migrations.migration_2026_11_received_source_private_config import migrate as clear_received_private
from flow_sdk.migrations.migration_2026_11_tags_and_labels import migrate


def run():
    report = migrate(dry_run=False)
    print(report.summary())  # noqa: T201 - migration runner report
    print(clear_received_private(dry_run=False).summary())  # noqa: T201 - migration runner report
    print(drop_contact_permissions(dry_run=False).summary())  # noqa: T201 - migration runner report
    return report
