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
    if report.converted:
        print(f"data drivers: gave {sum(report.converted.values())} authored driver(s) their family: {dict(report.converted)}.")  # noqa: T201 — migration output is user-facing
    else:
        print("data drivers: every authored driver already extends its family.")  # noqa: T201
    for reason, paths in report.unconverted.items():
        print(f"data drivers: left {len(paths)} as is ({reason}): {', '.join(paths)}")  # noqa: T201
    return {"drivers_converted": sum(report.converted.values()), "drivers_unconverted": sum(len(p) for p in report.unconverted.values())}
