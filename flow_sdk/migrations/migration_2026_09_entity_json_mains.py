"""One-shot migration: an ENTITY DOCUMENT's retired markdown main becomes ``<type>.json`` + its body file.

A type on the entity layout (``TypeInfo.manifest_layout == "entity"``) keeps every field in
``<type>.json`` and each ``Body`` beside it as ``<field>.md``. Folders written before that carry
the retired main named in ``TypeInfo.retired_mains`` (``agent/q/agent.md``): YAML frontmatter plus a
markdown body. The live scan reports such a folder and indexes nothing; this pass converts it.

Per folder, and only when ``<type>.json`` is still absent: the frontmatter ``id`` moves unchanged
(a folder without a valid v4/v5 id is left and reported), ``version`` is carried, every field the
spec declares is written (keys it does not declare are counted in ``dropped_keys``), the body becomes
``<field>.md``, the result is read back through the live reader, and only then is the retired file
removed. A folder holding both files is a conflict and is never touched; an unwritable one is reported.

The walk is every root the instance indexes (home, cwd, the system project, every project mount).
Idempotent: a second run finds no retired folder.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_entity_json_mains --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_entity_json_mains --apply
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("migrate.entity_json_mains")


@dataclass
class Report:
    scanned: int = 0
    #: True when nothing was written — ``converted`` is then what ``--apply`` would convert
    dry_run: bool = True
    #: type -> folders converted (in a dry run: what ``--apply`` would convert)
    converted: Counter = field(default_factory=Counter)
    #: "type:reason" -> folders left in the retired form
    unconverted: Counter = field(default_factory=Counter)
    #: folders holding both the retired and the current main
    conflicts: list[str] = field(default_factory=list)
    #: frontmatter keys the spec does not declare, dropped by the conversion
    dropped_keys: Counter = field(default_factory=Counter)

    @property
    def changed(self) -> bool:
        return bool(self.converted) and not self.dry_run


def retired_folders(root: Path) -> list[tuple[Any, Path, str]]:
    """``(info, folder, retired main)`` for every folder under ``root`` still carrying a retired main."""
    from flow_sdk.assets.scanning import scan_repo_tree
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    result = scan_repo_tree(root, SchemaRegistry.repo_family_to_info())
    # The scan reports a retired folder as an ISSUE precisely because it does not classify; a folder that
    # DOES classify already has its ``<type>.json`` and is a conflict, which ``convert`` reports untouched.
    found = [(SchemaRegistry.get(i.type_name), i.path, i.retired) for i in result.issues if i.retired and i.type_name]
    for candidate in result.candidates:
        info = SchemaRegistry.get(candidate.type_name)
        for retired in (info.retired_mains if info is not None else ()):
            if (candidate.path / retired).is_file():
                found.append((info, candidate.path, retired))
    # Only a markdown main that becomes an entity document; another type's retired main is a plain rename
    # (``migration_2026_09_retired_asset_forms``).
    return [(info, folder, retired) for info, folder, retired in found
            if info is not None and info.retired_migration.endswith("entity_json_mains")]


def convert(info: Any, folder: Path, retired: str) -> tuple[str, list[str]]:
    """``("converted" | "conflict" | "unconverted:<reason>", dropped keys)`` for one folder."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.assets.document import read_document
    from flow_sdk.assets.frontmatter import _atomic_write_text
    from flow_sdk.assets.serialization import entity_body_path, read_asset_data, render_entity_json, write_entity_bodies
    from flow_sdk.fs_store.serializer.fields import spec_layout

    old, main = folder / retired, folder / info.shape.main
    if main.exists():
        return "conflict", []
    if not os.access(folder, os.W_OK):
        return "unconverted:read-only", []
    document = read_document(old)
    if document.metadata_error:
        return "unconverted:malformed", []
    fields = dict(document.fields)
    entity_id = str(fields.pop("id", "") or "")
    if not is_valid_entity_id(entity_id):
        return "unconverted:no-valid-id", []
    version = fields.pop("version", None)
    name = str(fields.pop("name", "") or folder.name)
    spec, lay = info.asset_spec, spec_layout(info.asset_spec)
    dropped = sorted(key for key in fields if key not in spec.model_fields)
    # Rendered by the LIVE writer, so a converted file is byte-identical to what the next save writes.
    body = document.body.strip()
    authored = spec.model_validate({**fields, **({"name": name} if "name" in spec.model_fields else {}),
                                    **({lay.body: body} if lay.body else {})})
    written = [main, *([entity_body_path(folder, lay.body)] if lay.body else [])]
    _atomic_write_text(main, render_entity_json(authored, info, entity_id=entity_id, name=name, version=version))
    write_entity_bodies(authored, info, folder)
    record = read_asset_data(folder, info)
    if str(record.id) != entity_id or (lay.body and (getattr(record, lay.body, "") or "") != body):
        for path in written:
            path.unlink(missing_ok=True)
        return "unconverted:readback", dropped
    old.unlink()
    return "converted", dropped


def _default_roots() -> list[Path]:
    """The instance's index roots; without a store, the ones a fresh install still has."""
    try:
        from flow_sdk.migrations.migration_2026_09_identity_live_forms import _open, _roots

        conn = _open(None)
        try:
            return [Path(root._path) for root in _roots(conn)]
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — no store yet is an install, not a failure
        logger.info("entity documents: no instance store (%s); walking the default roots", type(exc).__name__)
        from flow_sdk.fs_store.indexer.roots import default_roots

        return [Path(root._path) for root in default_roots()]


def migrate(*, dry_run: bool = True, roots: list[Path] | None = None) -> Report:
    """Convert every retired entity-document folder under ``roots`` (the instance's when None)."""
    from flow_sdk.schema.type_info import register_all

    register_all()
    report = Report(dry_run=dry_run)
    seen: set[str] = set()
    for root in roots if roots is not None else _default_roots():
        for info, folder, retired in retired_folders(Path(root)):
            key = str(Path(folder).resolve())
            if info is None or key in seen:
                continue
            seen.add(key)
            report.scanned += 1
            if dry_run:
                report.converted[info.type_name] += 1
                continue
            try:
                status, dropped = convert(info, Path(folder), retired)
            except Exception as exc:  # noqa: BLE001 — one broken folder must not abort the run
                logger.warning("entity documents: %s not converted: %s", key, exc)
                status, dropped = f"unconverted:{type(exc).__name__}", []
            report.dropped_keys.update(dropped)
            if status == "converted":
                report.converted[info.type_name] += 1
            elif status == "conflict":
                report.conflicts.append(key)
            else:
                report.unconverted[f"{info.type_name}:{status.split(':', 1)[1]}"] += 1
    if report.changed:
        from flow_sdk.fs_store.fs_record import FSRecord

        for type_name in report.converted:
            FSRecord.clear_hashes_for_type(type_name)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convert retired markdown mains to <type>.json entity documents.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--root", action="append", default=None, help="Walk only this root (repeatable).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    dry_run = not args.apply
    report = migrate(dry_run=dry_run, roots=[Path(r) for r in args.root] if args.root else None)
    logger.info("%s: scanned %d retired folder(s)", "DRY-RUN" if dry_run else "APPLY", report.scanned)
    logger.info("%s: %s", "convertible" if dry_run else "converted", dict(report.converted))
    if report.unconverted:
        logger.info("left in the retired form: %s", dict(report.unconverted))
    if report.conflicts:
        logger.info("conflicts (both files present, untouched): %s", report.conflicts)
    if report.dropped_keys:
        logger.info("undeclared keys dropped: %s", dict(report.dropped_keys))
    return 0


if __name__ == "__main__":
    sys.exit(main())
