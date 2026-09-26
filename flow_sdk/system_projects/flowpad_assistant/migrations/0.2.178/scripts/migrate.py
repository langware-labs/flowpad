"""0.2.178 — every authored data driver extends its source family.

Runs ``flow_sdk.migrations.migration_2026_09_source_families`` once on upgrade. The loader now refuses a
driver class that extends ``Source`` / ``CollectionSource`` without ``ObjectSource``, ``RecordSource`` or
``MessageSource``; without this pass a driver written in a project before this release stops loading.
Idempotent — a converted instance reports zeros.

Entry point: ``run()``.
"""

from __future__ import annotations


def run() -> dict[str, int]:
    from flow_sdk.migrations.migration_2026_09_source_families import migrate

    report = migrate(dry_run=False)
    for line in report.lines():
        print(line)  # noqa: T201 — migration output is user-facing
    return {"drivers_converted": sum(report.converted.values()), "drivers_unconverted": sum(len(p) for p in report.unconverted.values())}
