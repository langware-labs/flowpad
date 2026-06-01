"""One-shot migration: consolidate per-entity pointer fields into the
unified ``context_entities`` list.

For each entity type below, walks all records in the local DB, projects the
legacy pointer fields into ``context_entities``, and saves the entity. The
legacy fields are no longer declared on the entity, so re-saving naturally
drops them from the wire/JSON shape.

Migrations performed:

  Task:
    spec_id          -> context_entities += [TypeId('spec', spec_id)]
    conversation_id  -> context_entities += [TypeId('conversation', conv_id)]
    links            -> dropped (no readers existed)
  Spec:
    plan_id          -> context_entities += [TypeId('plan', plan_id)]
  Conversation:
    task_id          -> context_entities += [TypeId('task', task_id)]
  FlowMessage:
    context          -> context_entities (rename)
  CollaborationRoom:
    agentic_process_ids -> context_entities += [TypeId('agentic_process', id) for id in ...]

Idempotent: re-running on a record that has already been migrated is a no-op.

Usage:
    uv run -m flow_sdk.migrations.migration_2026_05_consolidate_context_entities --dry-run
    uv run -m flow_sdk.migrations.migration_2026_05_consolidate_context_entities --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable

from flow_sdk.builtin.collaboration_room import CollaborationRoom
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.db.drivers.db_base_record import TypeId
from flow_sdk.db.drivers.query import QueryFilter

logger = logging.getLogger("migrate.context_entities")


def _all_raw_from_db(entity_cls) -> list[dict[str, Any]]:
    """Read raw record dicts straight from the SQLite ``entities.data`` blob.

    We bypass the entity model on the way in because the model now drops the
    legacy fields (``spec_id``, ``task_id``, etc.) before we'd ever see them
    — that's exactly what the migration needs to relocate.
    """
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.instance_settings import get_instance_settings

    db_path = get_instance_settings().db_path
    conn = open_sqlite(db_path)
    try:
        cur = conn.execute(
            "SELECT id, data FROM entities WHERE type = ?",
            (entity_cls.get_type(),),
        )
        rows: list[dict[str, Any]] = []
        for eid, blob in cur:
            data = json.loads(blob) if blob else {}
            data["id"] = data.get("id") or eid
            rows.append(data)
        return rows
    finally:
        conn.close()


def _ensure_typeid_list(value: Any) -> list[str]:
    """Normalize the existing context_entities value to ``list[str]``.
    Tolerates ``None``, ``list[str]``, ``list[TypeId]``, ``list[dict]``."""
    if not value:
        return []
    out: list[str] = []
    for v in value:
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict) and v.get("type") and v.get("id"):
            out.append(f"{v['type']}-{v['id']}")
        elif hasattr(v, "type") and hasattr(v, "id"):
            out.append(f"{v.type}-{v.id}")
    return out


def _planned_changes_for_task(raw: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Return (new_context_entities, dropped_field_names) for one Task."""
    ctx = _ensure_typeid_list(raw.get("context_entities"))
    dropped: list[str] = []
    if (sid := raw.get("spec_id")):
        tid = f"spec-{sid}"
        if tid not in ctx:
            ctx.append(tid)
        dropped.append("spec_id")
    if (cid := raw.get("conversation_id")):
        tid = f"conversation-{cid}"
        if tid not in ctx:
            ctx.append(tid)
        dropped.append("conversation_id")
    if raw.get("links"):
        dropped.append("links")  # No reader existed; just drop.
    return ctx, dropped


def _planned_changes_for_spec(raw: dict[str, Any]) -> tuple[list[str], list[str]]:
    ctx = _ensure_typeid_list(raw.get("context_entities"))
    dropped: list[str] = []
    if (pid := raw.get("plan_id")):
        tid = f"plan-{pid}"
        if tid not in ctx:
            ctx.append(tid)
        dropped.append("plan_id")
    return ctx, dropped


def _planned_changes_for_conversation(raw: dict[str, Any]) -> tuple[list[str], list[str]]:
    ctx = _ensure_typeid_list(raw.get("context_entities"))
    dropped: list[str] = []
    if (tid := raw.get("task_id")):
        full = f"task-{tid}"
        if full not in ctx:
            ctx.append(full)
        dropped.append("task_id")
    return ctx, dropped


def _planned_changes_for_flow_message(raw: dict[str, Any]) -> tuple[list[str], list[str]]:
    """FlowMessage's old field is ``context`` (already a list); rename to
    ``context_entities``. We still write through context_entities so the
    rename completes."""
    ctx = _ensure_typeid_list(raw.get("context_entities"))
    dropped: list[str] = []
    legacy = _ensure_typeid_list(raw.get("context"))
    if legacy:
        for tid in legacy:
            if tid not in ctx:
                ctx.append(tid)
        dropped.append("context")
    return ctx, dropped


def _planned_changes_for_room(raw: dict[str, Any]) -> tuple[list[str], list[str]]:
    ctx = _ensure_typeid_list(raw.get("context_entities"))
    dropped: list[str] = []
    procs = raw.get("agentic_process_ids") or []
    if procs:
        for pid in procs:
            tid = f"agentic_process-{pid}"
            if tid not in ctx:
                ctx.append(tid)
        dropped.append("agentic_process_ids")
    return ctx, dropped


_PLAN_FOR = {
    Task: _planned_changes_for_task,
    Spec: _planned_changes_for_spec,
    Conversation: _planned_changes_for_conversation,
    FlowMessage: _planned_changes_for_flow_message,
    CollaborationRoom: _planned_changes_for_room,
}


def _migrate_one_type(entity_cls, dry_run: bool) -> dict[str, int]:
    """Run the migration over every record of ``entity_cls``. Returns counts.

    Operates directly on the SQLite blob so we can both *see* the legacy
    fields and *strip* them in one shot — the entity model would round-trip
    them away on load.
    """
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.instance_settings import get_instance_settings

    plan_fn = _PLAN_FOR[entity_cls]
    raws = _all_raw_from_db(entity_cls)
    counts = {"scanned": 0, "changed": 0, "skipped": 0}
    db_path = get_instance_settings().db_path
    conn = open_sqlite(db_path)
    try:
        for raw in raws:
            counts["scanned"] += 1
            new_ctx, dropped = plan_fn(raw)
            existing_ctx = _ensure_typeid_list(raw.get("context_entities"))
            if not dropped and new_ctx == existing_ctx:
                counts["skipped"] += 1
                continue
            counts["changed"] += 1
            rid = raw["id"]
            logger.info(
                "%s/%s: ctx=%s (dropped=%s)",
                entity_cls.__name__, rid, new_ctx, dropped,
            )
            if dry_run:
                continue
            # Build the new blob: keep all current fields, swap in the new
            # context_entities, and remove the legacy ones.
            updated = dict(raw)
            updated["context_entities"] = new_ctx
            for k in dropped:
                updated.pop(k, None)
            new_blob = json.dumps(updated)
            conn.execute(
                "UPDATE entities SET data = ? WHERE id = ? AND type = ?",
                (new_blob, rid, entity_cls.get_type()),
            )
        if not dry_run:
            conn.commit()
    finally:
        conn.close()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")

    grand: dict[str, dict[str, int]] = {}
    for cls in [Task, Spec, Conversation, FlowMessage, CollaborationRoom]:
        logger.info("--- %s ---", cls.__name__)
        try:
            counts = _migrate_one_type(cls, dry_run=dry_run)
        except Exception as e:
            logger.exception("Migration of %s failed: %s", cls.__name__, e)
            return 1
        grand[cls.__name__] = counts
        logger.info("%s: scanned=%d changed=%d skipped=%d", cls.__name__, counts["scanned"], counts["changed"], counts["skipped"])

    logger.info("=== summary ===")
    logger.info(json.dumps(grand, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
