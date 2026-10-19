"""One-shot rename: legacy ``<type>/<type>-@<id>/`` record folders become ``<type>/<id>/``.

A record's shadow folder is ``<records_root>/<type>/<id>/`` (``shadow_dir_for``). Folders
written before that convention are named ``<type>-@<id>``. They still load — discovery walks
whatever is there — but everything that looks a record up BY id lands on the bare folder,
which does not exist: the ``.hash`` index sentinel is never found, so every such record reads
as "index required" on every run (41,173 of 63,256 folders on one instance).

This script renames each legacy folder to its bare id. It never deletes and never merges:

* a legacy folder with no ``metadata.json`` is not a record and is left alone;
* when the bare folder already exists (the id was re-saved under the new convention, so the
  bare one is the live record) the legacy folder is left in place and counted as a collision;
* the id is the one in the folder NAME — the address every reader computes — never a
  different one found inside ``metadata.json``.

Idempotent: a clean store reports zeros and touches nothing. The rename is one ``os.rename``
per folder inside one directory, so an interrupted run leaves every record whole.

Approved by the user on 2026-10-10 ("5. rename once").

Usage (dry-run is the default; ``--apply`` renames):
    uv run -m flow_sdk.migrations.migration_2026_10_shadow_dir_rename
    uv run -m flow_sdk.migrations.migration_2026_10_shadow_dir_rename --apply
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_LEGACY_SEP = "-@"


@dataclass
class Report:
    renamed: int = 0
    collisions: list[str] = field(default_factory=list)
    not_records: int = 0
    errors: list[str] = field(default_factory=list)

    def summary(self, dry_run: bool = False) -> str:
        verb = "would rename" if dry_run else "renamed"
        return (
            f"shadow dirs: {verb} {self.renamed} legacy folder(s); "
            f"{len(self.collisions)} left in place (bare folder already exists); "
            f"{self.not_records} without metadata.json skipped; {len(self.errors)} error(s)."
        )


def _records_root() -> Path:
    from flow_sdk.fs_store.record_paths import get_default_records_root

    return Path(get_default_records_root())


def run(records_root: Path | None = None, *, apply: bool = False) -> Report:
    from flow_sdk.fs_store.record_paths import is_record_dir  # noqa: PLC0415

    root = Path(records_root) if records_root is not None else _records_root()
    report = Report()
    if not root.is_dir():
        return report
    for type_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        prefix = type_dir.name + _LEGACY_SEP
        try:
            children = sorted(os.listdir(type_dir))
        except OSError as exc:
            report.errors.append(f"{type_dir}: {exc}")
            continue
        for name in children:
            if not name.startswith(prefix):
                continue
            uid = name[len(prefix):]
            legacy = type_dir / name
            if not uid or not is_record_dir(legacy):
                report.not_records += 1
                continue
            target = type_dir / uid
            if os.path.lexists(target):
                report.collisions.append(str(legacy))
                continue
            if apply:
                try:
                    os.rename(legacy, target)
                except OSError as exc:
                    report.errors.append(f"{legacy}: {exc}")
                    continue
            report.renamed += 1
    for path in report.collisions[:20]:
        logger.warning("[shadow-rename] kept %s: the bare folder already exists", path)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--apply", action="store_true", help="rename (default is a dry run)")
    parser.add_argument("--records-root", type=Path, default=None)
    args = parser.parse_args(argv)
    report = run(args.records_root, apply=args.apply)
    print(report.summary(dry_run=not args.apply))  # noqa: T201 — the script's own output
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
