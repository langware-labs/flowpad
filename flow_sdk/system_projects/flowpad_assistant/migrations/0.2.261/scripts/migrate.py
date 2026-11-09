"""0.2.261: ``labels`` leaves every row; every stored tag becomes a valid one."""

from flow_sdk.migrations.migration_2026_11_tags_and_labels import migrate


def run():
    report = migrate(dry_run=False)
    print(report.summary())  # noqa: T201 - migration runner report
    return report
