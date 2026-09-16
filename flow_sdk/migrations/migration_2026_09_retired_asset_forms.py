"""One-shot migration: an asset still in a RETIRED form moves or renames into its type's current one.

A type declares its current layout (``TypeInfo.family`` / ``shape.main``) and the forms it left behind:
``retired_families`` (``agentic-assets/data_source/``) and ``retired_mains`` (``data_source.json``). The
live scan reports an asset in either and indexes nothing; this pass converts it. It is generic — any type
that declares a retired form is converted, with no per-type code.

An entity document's retired main is a different FORMAT, converted by
``migration_2026_09_entity_json_mains``; this pass leaves those types alone (``TypeInfo.retired_migration``
says which pass owns a type).

Per folder: a retired-family folder moves to ``<family>/<name>/`` only when that destination is absent,
and a retired main is renamed to the current main only when the current main is absent. Anything already
present is a conflict and is never touched; an unwritable folder (an install tree) is reported. A retired
family left empty is removed. Nested assets ride inside the folder they live in.

A retired FILE (``TypeInfo.retired_files``, a retired runtime's ``fetch.py``) is code, not a layout:
the folder is still moved and renamed, and listed in ``needs_port`` so the result never reads as done.

Idempotent: a second run finds no retired form (a folder that still needs its port is listed again).

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_retired_asset_forms
    uv run -m flow_sdk.migrations.migration_2026_09_retired_asset_forms --apply
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MIGRATION = "migration_2026_09_retired_asset_forms"


@dataclass
class Report:
    #: True when nothing was written — the counts are then what ``--apply`` would do
    dry_run: bool = True
    #: folders moved out of a retired family
    moved: int = 0
    #: retired mains renamed to the current one
    renamed: int = 0
    #: folders left because the current form already exists beside them
    conflicts: list[str] = field(default_factory=list)
    #: folders left because they cannot be written (an install tree)
    read_only: list[str] = field(default_factory=list)
    #: folders (converted or not) that still hold a retired file no migration can convert — port by hand
    needs_port: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.moved or self.renamed) and not self.dry_run

    def summary(self) -> str:
        verb = "would move" if self.dry_run else "moved"
        return (f"retired asset forms: {verb} {self.moved} folder(s), renamed {self.renamed} main(s), "
                f"{len(self.conflicts)} conflict(s), {len(self.read_only)} read-only"
                + (f"; {len(self.needs_port)} need a manual port: {', '.join(self.needs_port)}." if self.needs_port else "."))


def _owned(info: Any) -> bool:
    return bool(info is not None and (info.retired_families or info.retired_mains or info.retired_files)
                and info.retired_migration.endswith(MIGRATION))


def retired_folders(root: Path) -> list[tuple[Any, Path]]:
    """``(info, folder)`` for every asset under ``root`` in a retired form this pass owns — including a
    current folder that ALSO holds a retired main (a conflict ``convert`` reports)."""
    from flow_sdk.assets.scanning import scan_repo_tree
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    result = scan_repo_tree(root, SchemaRegistry.repo_family_to_info())
    found = [(SchemaRegistry.get(i.type_name), Path(i.path)) for i in result.issues if i.type_name]
    for candidate in result.candidates:
        info = SchemaRegistry.get(candidate.type_name)
        if _owned(info) and any((candidate.path / name).is_file() for name in info.retired_mains):
            found.append((info, Path(candidate.path)))
    return [(info, folder) for info, folder in found if _owned(info)]


def convert(info: Any, folder: Path, *, dry_run: bool, report: Report) -> None:
    main = info.shape.main
    target = folder
    if folder.parent.name in info.retired_families:
        target = folder.parent.parent / info.family / folder.name
        if target.exists():
            report.conflicts.append(str(folder))
            return
        if not os.access(folder.parent, os.W_OK):
            report.read_only.append(str(folder))
            return
        if not dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            folder.rename(target)
            try:
                folder.parent.rmdir()  # only when the retired family is now empty
            except OSError:
                pass
        report.moved += 1
    here = folder if dry_run else target
    if any((here / name).is_file() for name, _ in info.retired_files):
        report.needs_port.append(str(here))
    retired = next((here / name for name in info.retired_mains if (here / name).is_file()), None)
    if retired is None:
        return
    if main and (here / main).exists():
        report.conflicts.append(str(here))
        return
    if not dry_run:
        retired.rename(here / main)
    report.renamed += 1


def migrate(*, dry_run: bool = True, roots: list[Path] | None = None) -> Report:
    """Convert every retired asset form under ``roots`` (the instance's index roots when None)."""
    from flow_sdk.migrations.migration_2026_09_entity_json_mains import _default_roots
    from flow_sdk.schema.type_info import register_all

    register_all()
    report = Report(dry_run=dry_run)
    seen: set[str] = set()
    for root in roots if roots is not None else _default_roots():
        for info, folder in retired_folders(Path(root)):
            key = str(folder.resolve())
            if key not in seen:
                seen.add(key)
                convert(info, folder, dry_run=dry_run, report=report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    print(migrate(dry_run=not parser.parse_args(argv).apply).summary())  # noqa: T201 — CLI output
    return 0


if __name__ == "__main__":
    sys.exit(main())
