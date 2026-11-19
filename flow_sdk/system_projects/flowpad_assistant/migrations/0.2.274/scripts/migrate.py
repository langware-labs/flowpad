"""0.2.274: a callback rule and its session hold each other in shared context; an ended rule keeps its session."""

from flow_sdk.migrations.migration_2026_11_callback_session_link import migrate


def run():
    report = migrate(dry_run=False)
    print(report.summary())  # noqa: T201 - migration runner report
    return report
