"""Migrate Project entity ids from path-derived uuid5 → opaque uuid4.

Project entity ids are now random uuid4 (so a project is shared under its own id,
the Conversation model). The path-derived value survives only as a record-match
alias (`Project.derive_id_for_path`). This one-shot rewrites every existing
v5-id project to a v4 id and re-points every reference to it:

  * the project's own `entities` row (id + `data.id`, and drops the retired
    `cloud_id` field),
  * child `project_id` blobs on every entity (Tab / AgenticProcess / Conversation
    / ContactPermission / MessageAttachment / Prompt / Shell / Artifact / …),
  * relationship edges (`relationships.from_id`/`to_id` where the type is
    `project`) — is_child parent→child, source_entity, owner self-loop,
  * the `links` resolved-reference cache,
  * the on-disk record shadow folder `records/project/project-@<old>/`.

Already-shared projects reuse their `cloud_id` (already v4) as the new id so the
hub binding is preserved; the recipient's mirror is already v4 and is skipped.

Contract:
* Idempotent — a project whose id is already v4 is skipped.
* Crash-safe — the {old:new} map is persisted next to the db BEFORE mutating, so
  a retry after a partial run reuses the same ids (random uuid4 would otherwise
  diverge the db from the renamed shadow dirs).
* Backs up the sqlite db to `<db>.pre-uuid4.bak` before the first write.
* `run(*, dry_run=False)` — the runner calls `run()` (no args); pass
  `dry_run=True` to preview counts without writing.

Entry point: `run()`.
"""
from __future__ import annotations

import json
import logging
import shutil
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

_MARKER_NAME = ".uuid4_project_migration.json"


def _is_v4(value: str | None) -> bool:
    try:
        return bool(value) and uuid.UUID(value).version == 4
    except (ValueError, AttributeError, TypeError):
        return False


def _is_v5(value: str | None) -> bool:
    try:
        return bool(value) and uuid.UUID(value).version == 5
    except (ValueError, AttributeError, TypeError):
        return False


def _build_mapping(conn, persisted: dict[str, str]) -> dict[str, str]:
    """old→new id map for every v5 project row (v4 rows are skipped).

    Reuses any persisted mapping (deterministic on retry); already-shared
    projects reuse their v4 ``cloud_id`` as the new id, else a fresh uuid4.
    """
    mapping: dict[str, str] = {}
    for eid, blob in conn.execute(
        "SELECT id, data FROM entities WHERE type = 'project'"
    ).fetchall():
        if not _is_v5(eid):
            continue
        if eid in persisted and _is_v4(persisted[eid]):
            mapping[eid] = persisted[eid]
            continue
        data = json.loads(blob) if blob else {}
        cloud_id = data.get("cloud_id")
        mapping[eid] = cloud_id if _is_v4(cloud_id) else str(uuid.uuid4())
    return mapping


def _apply_mapping(conn, mapping, records_root, records_data_root, *, dry_run):
    """Rewrite project rows, child blobs, edges, links, and shadow dirs.

    Returns a counts dict. Does NOT commit (the caller owns the transaction) —
    except that the shadow-dir renames are filesystem side effects done here.
    """
    from flow_sdk.fs_store import record_stem

    counts = {"projects": len(mapping), "child_blobs": 0, "rel_from": 0,
              "rel_to": 0, "links": 0, "shadow_dirs": 0}

    # Project rows + their edges/links.
    for old_id, new_id in mapping.items():
        row = conn.execute(
            "SELECT data FROM entities WHERE id = ? AND type = 'project'",
            (old_id,),
        ).fetchone()
        data = json.loads(row[0]) if row and row[0] else {}
        data["id"] = new_id
        data.pop("cloud_id", None)
        if dry_run:
            # Count (don't mutate) so the preview is accurate.
            counts["rel_from"] += conn.execute(
                "SELECT COUNT(*) FROM relationships WHERE from_id = ? AND from_type = 'project'",
                (old_id,)).fetchone()[0]
            counts["rel_to"] += conn.execute(
                "SELECT COUNT(*) FROM relationships WHERE to_id = ? AND to_type = 'project'",
                (old_id,)).fetchone()[0]
            counts["links"] += conn.execute(
                "SELECT COUNT(*) FROM links WHERE target_resolved_id = ? AND target_resolved_type = 'project'",
                (old_id,)).fetchone()[0]
            counts["links"] += conn.execute(
                "SELECT COUNT(*) FROM links WHERE src_id = ? AND src_type = 'project'",
                (old_id,)).fetchone()[0]
            continue
        conn.execute(
            "UPDATE entities SET id = ?, data = ? WHERE id = ? AND type = 'project'",
            (new_id, json.dumps(data), old_id),
        )
        counts["rel_from"] += conn.execute(
            "UPDATE relationships SET from_id = ? WHERE from_id = ? AND from_type = 'project'",
            (new_id, old_id),
        ).rowcount
        counts["rel_to"] += conn.execute(
            "UPDATE relationships SET to_id = ? WHERE to_id = ? AND to_type = 'project'",
            (new_id, old_id),
        ).rowcount
        counts["links"] += conn.execute(
            "UPDATE links SET target_resolved_id = ? "
            "WHERE target_resolved_id = ? AND target_resolved_type = 'project'",
            (new_id, old_id),
        ).rowcount
        counts["links"] += conn.execute(
            "UPDATE links SET src_id = ? WHERE src_id = ? AND src_type = 'project'",
            (new_id, old_id),
        ).rowcount

    # Child `project_id` blobs. Prefilter in SQL (json_extract runs in C) so we
    # only deserialize rows that actually carry a project_id, not every entity.
    for eid, etype, blob in conn.execute(
        "SELECT id, type, data FROM entities "
        "WHERE json_extract(data, '$.project_id') IS NOT NULL"
    ).fetchall():
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except (ValueError, TypeError):
            continue
        new_pid = mapping.get(data.get("project_id"))
        if new_pid is None:
            continue
        counts["child_blobs"] += 1
        if not dry_run:
            data["project_id"] = new_pid
            conn.execute(
                "UPDATE entities SET data = ? WHERE id = ? AND type = ?",
                (json.dumps(data), eid, etype),
            )

    # On-disk record shadow folders (both stem shapes).
    for old_id, new_id in mapping.items():
        for root in (records_root, records_data_root):
            base = Path(root) / "project"
            for sub_old, sub_new in (
                (record_stem("project", old_id), record_stem("project", new_id)),
                (old_id, new_id),  # legacy id-only shape
            ):
                src, dst = base / sub_old, base / sub_new
                if src.exists() and not dst.exists():
                    counts["shadow_dirs"] += 1
                    if not dry_run:
                        src.rename(dst)

    return counts


def run(*, dry_run: bool = False) -> None:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.fs_store import (
        get_default_records_data_root,
        get_default_records_root,
    )
    from flow_sdk.instance_settings import get_instance_settings

    db_path = Path(get_instance_settings().db_path)
    if not db_path.exists():
        logger.info("[uuid4-migrate] no db at %s — nothing to do", db_path)
        return

    marker = db_path.parent / _MARKER_NAME
    persisted: dict[str, str] = {}
    if marker.exists():
        try:
            persisted = json.loads(marker.read_text(encoding="utf-8")) or {}
        except (OSError, ValueError):
            persisted = {}

    conn = open_sqlite(db_path)
    try:
        mapping = _build_mapping(conn, persisted)
        if not mapping:
            logger.info("[uuid4-migrate] no v5 projects to migrate — done")
            return

        logger.info(
            "[uuid4-migrate] %d project(s) to migrate%s",
            len(mapping), " (dry-run)" if dry_run else "",
        )

        if not dry_run:
            # Persist the map (crash-safety) + back up the db before writing.
            marker.write_text(json.dumps({**persisted, **mapping}, indent=1), encoding="utf-8")
            bak = db_path.with_suffix(db_path.suffix + ".pre-uuid4.bak")
            if not bak.exists():
                shutil.copy2(db_path, bak)
                logger.info("[uuid4-migrate] backed up db → %s", bak)

        counts = _apply_mapping(
            conn, mapping,
            get_default_records_root(), get_default_records_data_root(),
            dry_run=dry_run,
        )
        if not dry_run:
            conn.commit()

        logger.info(
            "[uuid4-migrate] %s: projects=%d child_blobs=%d rel_from=%d rel_to=%d "
            "links=%d shadow_dirs=%d",
            "PLAN" if dry_run else "DONE",
            counts["projects"], counts["child_blobs"], counts["rel_from"],
            counts["rel_to"], counts["links"], counts["shadow_dirs"],
        )
    finally:
        conn.close()


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    run(dry_run="--dry-run" in sys.argv)
