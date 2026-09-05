"""Indexer-backed serving for the resource-browser scan actions.

Replaces the deleted ``system_profile/scanner.py`` dispatch. Each
``scan-resources`` / ``scan-project`` / ``get-resource-summary`` request runs
the canonical FSIndexer (``get_shared_indexer``) for the requested
``EntityType``, parses the discovered FSRefs via their ``from_disk_fn``, and
then filters / sorts / paginates in Python — preserving the exact response
shapes the frontend depends on.

The indexer is the single filesystem scanner; this module is a thin
query+projection layer over it (mirrors ``project_list.list_projects_from_indexer``).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.asset_occurrences import asset_occurrence_dicts
from flow_sdk.fs_store.indexer import IndexerOptions, get_shared_indexer
from flow_sdk.fs_store.indexer.index_function import (
    preload_owners,
    resolve_collisions,
    resolve_ref_identity,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType

SYSTEM_RESOURCE_PREFIX = "system_resource_claude_"

# Frontend simple resource name → indexer EntityType. The frontend always sends
# the prefixed form (e.g. ``system_resource_claude_hook``); ``hook`` maps to the
# ``claude_hook`` EntityType (the one name that isn't 1:1).
RESOURCE_TYPE_TO_ENTITY: dict[str, EntityType] = {
    "hook": EntityType.CLAUDE_HOOK,
    "claude_session": EntityType.CLAUDE_SESSION,
    "skill": EntityType.SKILL,
    "plugin": EntityType.PLUGIN,
    "command": EntityType.COMMAND,
    "subagent": EntityType.SUBAGENT,
    "todo_file": EntityType.TODO_FILE,
    "mcp_server": EntityType.MCP_SERVER,
    "claude_md": EntityType.CLAUDE_MD,
}

# Child-resource filter: simple type → the item field carrying its parent id.
PARENT_KEY_MAP: dict[str, str] = {
    "claude_session": "cwd",
    "codex_session": "project_id",
    "todo_file": "session_id",
}


def get_system_resource_type(simple_name: str) -> str:
    return f"{SYSTEM_RESOURCE_PREFIX}{simple_name}"


def get_simple_resource_type(full_type: str) -> str:
    if full_type.startswith(SYSTEM_RESOURCE_PREFIX):
        return full_type[len(SYSTEM_RESOURCE_PREFIX):]
    return full_type


def _iso_mtime(path: str | None) -> str | None:
    if not path:
        return None
    try:
        return datetime.fromtimestamp(Path(path).stat().st_mtime).isoformat()
    except OSError:
        return None


def _normalize(d: dict, simple: str, full: str) -> dict:
    """Stamp resource_type + simple type and guarantee a ``modified_at``."""
    d["type"] = simple
    d["resource_type"] = full
    if not d.get("modified_at"):
        for k in ("source_file", "path", "jsonl_path", "asset_ref"):
            m = _iso_mtime(d.get(k))
            if m:
                d["modified_at"] = m
                break
    return d


async def _project_nodes(
    nodes, entity_type: EntityType, simple: str, full: str,
    stored=None,
) -> list[dict]:
    """Project the terminal FSRefs of one type into deduped, normalized dicts."""
    info = SchemaRegistry.get(str(entity_type))
    from_disk = info.from_disk_fn if info else None
    if from_disk is None:
        return []
    et = str(entity_type)
    out: list[dict] = []
    seen: set[str] = set()
    resolved: list[tuple[Any, str, str]] = []

    # The SAME pipeline the walk runs (``index_function``): rows first — who
    # already owns each path, or a source whose capsule was wiped mints a fresh
    # id and forks its entity — then one identity per ref, then collision
    # resolution against the stored occurrences. One fetch feeds all three.
    from flow_sdk.db import get_db_driver  # noqa: PLC0415

    preload = await preload_owners(get_db_driver(), [et])
    for n in nodes:
        if n.record_type is None or str(n.record_type) != et:
            continue
        try:
            rid, canon = resolve_ref_identity(info, n, preload)
            resolved.append((n, rid, canon))
        except Exception:
            continue

    if stored is None:
        stored = preload.occurrences

    def _live_identity(candidate):
        _node, rid, path = candidate
        return et, rid, path

    decisions = await asyncio.to_thread(resolve_collisions, resolved, stored, _live_identity)
    decision_by_id = {item.entity_id: item for item in decisions}
    duplicates = {
        (item.entity_id, path)
        for item in decisions
        for path in item.duplicate_paths
    }
    for item in decisions:
        if item.duplicate_paths:
            logging.warning(
                "[asset-id] duplicate asset id; type=%s id=%s kept=%s skipped=%s",
                et,
                item.entity_id,
                item.primary_path,
                ",".join(item.duplicate_paths),
            )
    for n, resolved_id, path in resolved:
        if (resolved_id, path) in duplicates:
            continue
        try:
            recs = from_disk(n, resolved_id)
        except Exception:
            continue
        for rec in recs or []:
            d = rec.meta_dict()
            decision = decision_by_id.get(resolved_id)
            if decision is not None:
                d["asset_occurrences"] = asset_occurrence_dicts(decision.occurrences)
                d["duplicate_count"] = len(decision.duplicate_paths)
            rid = d.get("id")
            if rid is not None:
                if rid in seen:
                    continue
                seen.add(rid)
            out.append(_normalize(d, simple, full))
    return out


async def _walk_type_records(
    entity_type: EntityType, scoped_roots, simple: str, full: str
) -> list[dict]:
    """Run the indexer for one type and project every terminal FSRef to a dict."""
    # Resolve the indexer first — building it imports ``registrations`` and
    # populates SchemaRegistry, so ``from_disk_fn`` lookup is order-independent.
    idx = get_shared_indexer()
    nodes = await idx.scan(
        IndexerOptions(types=[RecordType(str(entity_type))], roots=scoped_roots)
    )
    return await _project_nodes(nodes, entity_type, simple, full)


def _in_window(modified_at: str | None, start: str | None, end: str | None) -> bool:
    if not modified_at:
        return False
    if start and modified_at < start:
        return False
    if end and modified_at > end:
        return False
    return True


async def scan_resources_from_indexer(
    resource_type: str,
    scoped_roots,
    *,
    time_window: dict | None = None,
    parent_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """Serve ``scan-resources`` from the indexer. Preserves the legacy envelope."""
    simple = get_simple_resource_type(resource_type)
    full = get_system_resource_type(simple)

    if simple == "project":
        from flow_sdk.builtin.faas.project_list import list_projects_from_indexer
        items = (await list_projects_from_indexer())["projects"]
    else:
        entity_type = RESOURCE_TYPE_TO_ENTITY.get(simple)
        if entity_type is None:
            return {
                "items": [],
                "error": f"Unknown type: {resource_type}",
                "resource_type": resource_type,
            }
        items = await _walk_type_records(entity_type, scoped_roots, simple, full)

    if time_window:
        start, end = time_window.get("start"), time_window.get("end")
        items = [i for i in items if _in_window(i.get("modified_at"), start, end)]

    if parent_id:
        parent_key = PARENT_KEY_MAP.get(simple)
        if parent_key:
            items = [i for i in items if i.get(parent_key) == parent_id]

    items.sort(key=lambda x: x.get("modified_at") or "", reverse=True)

    total_count = len(items)
    # limit <= 0 means "no limit" (return everything from offset).
    if limit and limit > 0:
        page = items[offset:offset + limit]
        has_more = offset + limit < total_count
    else:
        page = items[offset:]
        has_more = False

    mts = [i.get("modified_at") for i in page if i.get("modified_at")]
    scanned_window = {"start": min(mts), "end": max(mts)} if mts else (time_window or {})

    return {
        "items": page,
        "scanned_window": scanned_window,
        "total_count": total_count,
        "has_more": has_more,
        "resource_type": full,
    }


async def get_resource_summary_from_indexer(scoped_roots) -> dict:
    """Serve ``get-resource-summary`` — per-type counts from the indexer.

    One multi-type walk over the roots, then bucket + count per type — instead
    of a separate full walk per type.
    """
    idx = get_shared_indexer()
    all_types = [RecordType(str(et)) for et in RESOURCE_TYPE_TO_ENTITY.values()]
    nodes = await idx.scan(IndexerOptions(types=all_types, roots=scoped_roots))

    by_type: dict[str, list] = {}
    for n in nodes:
        if n.record_type is not None:
            by_type.setdefault(str(n.record_type), []).append(n)

    summary: dict[str, int] = {}
    for simple, entity_type in RESOURCE_TYPE_TO_ENTITY.items():
        full = get_system_resource_type(simple)
        try:
            items = await _project_nodes(
                by_type.get(str(entity_type), []), entity_type, simple, full,
            )
            summary[full] = len(items)
        except Exception:
            summary[full] = 0
    return summary


# ── scan-project: per-project resources via a single REAL_PROJECT_CWD walk ────

# Response key → (simple resource name, EntityType) for the per-project walk.
_PROJECT_TYPES: dict[str, tuple[str, EntityType]] = {
    "hooks": ("hook", EntityType.CLAUDE_HOOK),
    "mcp_servers": ("mcp_server", EntityType.MCP_SERVER),
    "commands": ("command", EntityType.COMMAND),
    "agents": ("subagent", EntityType.SUBAGENT),
    "skills": ("skill", EntityType.SKILL),
    "claude_md": ("claude_md", EntityType.CLAUDE_MD),
}


def _project_sessions(encoded_name: str, jsonls: list[Path], limit: int) -> list[dict]:
    """Sessions for one encoded project (mirrors the old get_sessions_for_project)."""
    from flow_sdk.fs_store.indexer.functions.claude_sessions import (
        claude_session_meta_dict,
        extract_claude_session_from_path,
    )

    sessions: list[dict] = []
    jsonls = sorted(jsonls, key=lambda p: p.stat().st_mtime, reverse=True)
    full = get_system_resource_type("claude_session")
    for jsonl in jsonls:
        if limit > 0 and len(sessions) >= limit:
            break
        try:
            rec = extract_claude_session_from_path(jsonl)
            d = claude_session_meta_dict(rec)
        except Exception:
            continue
        if not (
            d.get("message_count")
            or d.get("assistant_message_count")
            or d.get("user_message_count")
        ):
            continue
        d["scope"] = [f"project:{encoded_name}"]
        d["type"] = full
        d["resource_type"] = full
        if not d.get("modified_at"):
            d["modified_at"] = _iso_mtime(str(jsonl))
        sessions.append(d)
    return sessions


async def scan_project_from_indexer(
    project_encoded_name: str,
    session_limit: int = 100,
    include_sessions: bool = True,
) -> dict:
    """Serve ``scan-project`` — one project's resources via an indexer sub-walk."""
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions._claude_projects import (
        _claude_projects_dir,
        decode_claude_project_dir,
    )
    from flow_sdk.fs_store.scope import Scope

    project_dir = _claude_projects_dir() / project_encoded_name
    if not project_dir.exists():
        return {"error": f"Project not found: {project_encoded_name}"}

    decoded = decode_claude_project_dir(project_dir)
    project_cwd = str(decoded) if decoded is not None else None

    result: dict[str, Any] = {
        "project_cwd": project_cwd,
        "scanned_at": datetime.now().isoformat(),
    }

    jsonls = list(project_dir.glob("*.jsonl"))
    result["total_session_count"] = len(jsonls)
    result["sessions"] = (
        _project_sessions(project_encoded_name, jsonls, session_limit)
        if include_sessions
        else []
    )

    # Per-project config resources via a single REAL_PROJECT_CWD-rooted walk.
    buckets: dict[str, list[dict]] = {k: [] for k in _PROJECT_TYPES}
    if project_cwd and Path(project_cwd).is_dir():
        root = FSRef(
            Path(project_cwd),
            record_type=RecordType.REAL_PROJECT_CWD,
            scope=Scope.PROJECT.value,
            project_id=Project.derive_id_for_path(Path(project_cwd)),
        )
        scoped_roots = [root]
        for key, (simple, entity_type) in _PROJECT_TYPES.items():
            full = get_system_resource_type(simple)
            try:
                buckets[key] = await _walk_type_records(entity_type, scoped_roots, simple, full)
            except Exception:
                buckets[key] = []
    result.update(buckets)
    # Project-linked todos are not served by the user-global todo walker.
    result["todos"] = []

    result["summary"] = {
        "sessions": len(result["sessions"]),
        "hooks": len(result["hooks"]),
        "mcp_servers": len(result["mcp_servers"]),
        "commands": len(result["commands"]),
        "agents": len(result["agents"]),
        "skills": len(result["skills"]),
        "claude_md": len(result["claude_md"]),
        "todos": len(result["todos"]),
    }
    return result
