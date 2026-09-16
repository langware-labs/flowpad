"""One-shot migration: the configured data source entity's type string ``data_source`` -> ``data_driver``.

The rename itself is ``entity_type_rename.rename_entity_type``. What stays ``data_source`` on purpose:
``data_source_cursor`` and ``data_source_spec`` (different types), the ``data_source_id`` field, and the
webhook URL ``/api/v1/data_source/webhook/<name>`` providers hold.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_data_driver_rename
    uv run -m flow_sdk.migrations.migration_2026_09_data_driver_rename --apply
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from flow_sdk.migrations.entity_type_rename import Report, rename_entity_type

OLD, NEW = "data_source", "data_driver"


def migrate(*, dry_run: bool = True, db: Path | None = None, shadow_roots: list[Path] | None = None) -> Report:
    return rename_entity_type(OLD, NEW, dry_run=dry_run, db=db, shadow_roots=shadow_roots)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    print(migrate(dry_run=not parser.parse_args(argv).apply).summary())  # noqa: T201 — CLI output
    return 0


if __name__ == "__main__":
    sys.exit(main())
