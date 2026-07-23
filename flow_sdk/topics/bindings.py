"""Topic binding readers — the carriers ARE the edge store.

One reader per carrier, each returning ALL bindings (optionally filtered to a
topic subtree). Consumed by both the context route (``flow topic get``) and
the topic graph projection, so the derivation logic lives exactly once.

Carriers:
* markdown frontmatter ``topics:`` → entity rows (``Docs.topics``)
* skill frontmatter ``topics:``    → ``skill.metadata.topics`` (generic dump)
* source-file ``topic`` capsules   → filesystem scan under a root
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from flow_sdk.topics.grammar import topic_is_within

_CAPSULE_MARKER = "flowpad:capsule topic"
_MAX_SCAN_FILE_BYTES = 2_000_000


def _matched(topics: list[str], name: Optional[str]) -> list[str]:
    valid = sorted(t for t in topics if isinstance(t, str))
    if name is None:
        return valid
    return [t for t in valid if topic_is_within(t, name)]


async def _rows_of_type(types: tuple[str, ...]) -> list[tuple[str, str, dict[str, Any]]]:
    """One scan for every carrier type — ``[(type, id, data), ...]``.

    Deliberately a single query: inside a request all ``session()`` blocks
    share one AsyncSession, so separate reads cannot run concurrently anyway;
    collapsing them removes N table scans and N round trips.
    """
    from sqlalchemy import select as sa_select  # noqa: PLC0415

    from flow_sdk.db import session as _session  # noqa: PLC0415
    from flow_sdk.db.drivers.sqlite.connection import EntitySchema  # noqa: PLC0415

    out: list[tuple[str, str, dict[str, Any]]] = []
    async with _session(write=False) as s:
        result = await s.execute(
            sa_select(EntitySchema.type, EntitySchema.id, EntitySchema.data).where(
                EntitySchema.type.in_(types)
            )
        )
        for row_type, row_id, raw in result.all():
            try:
                data = raw if isinstance(raw, dict) else json.loads(raw or "{}")
            except (TypeError, ValueError):
                continue
            out.append((row_type, row_id, data))
    return out


def _doc_binding(row_id: str, data: dict[str, Any], name: Optional[str],
                 with_body: bool) -> Optional[dict[str, Any]]:
    matched = _matched(data.get("topics") or [], name)
    if not matched:
        return None
    binding = {
        "id": row_id,
        "title": data.get("title") or data.get("name") or "",
        "asset_ref": data.get("asset_ref") or "",
        "topics": matched,
    }
    # The body is only for renderers (``flow topic get --mode full``); the
    # graph projection never reads it, so it stays out of that payload.
    if with_body:
        binding["body"] = data.get("body")
    return binding


def _skill_binding(row_id: str, data: dict[str, Any], name: Optional[str]) -> Optional[dict[str, Any]]:
    metadata = data.get("metadata") or {}
    topics = metadata.get("topics") if isinstance(metadata, dict) else None
    matched = _matched(topics or [], name)
    if not matched:
        return None
    return {"id": row_id, "name": data.get("name") or "", "topics": matched}


async def all_doc_bindings(
    name: Optional[str] = None, *, with_body: bool = True
) -> list[dict[str, Any]]:
    """Markdown entities carrying a ``topics`` list (optionally within ``name``)."""
    out = [
        binding
        for _t, row_id, data in await _rows_of_type(("markdown",))
        if (binding := _doc_binding(row_id, data, name, with_body)) is not None
    ]
    out.sort(key=lambda d: (d["title"], d["id"]))
    return out


async def all_skill_bindings(name: Optional[str] = None) -> list[dict[str, Any]]:
    """Skill entities whose frontmatter carried ``topics:`` (rides the generic
    ``skill.metadata`` dump). Returns ``[{id, name, topics}]``."""
    out = [
        binding
        for _t, row_id, data in await _rows_of_type(("skill",))
        if (binding := _skill_binding(row_id, data, name)) is not None
    ]
    out.sort(key=lambda d: (d["name"], d["id"]))
    return out


async def all_entity_bindings(name: Optional[str] = None) -> dict[str, list[dict[str, Any]]]:
    """Every entity-carried binding in ONE scan — ``{topics, docs, skills}``.

    The graph projection needs all three; going through the per-carrier
    readers would scan the entity table three times for the same rows.
    """
    topics: list[dict[str, Any]] = []
    docs: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    for row_type, row_id, data in await _rows_of_type(("topic", "markdown", "skill")):
        if row_type == "topic":
            topic_name = data.get("name")
            if isinstance(topic_name, str):
                topics.append({
                    "name": topic_name,
                    "id": row_id,
                    "title": data.get("title"),
                    "description": data.get("description"),
                    "system": bool(data.get("system")),
                })
        elif row_type == "markdown":
            binding = _doc_binding(row_id, data, name, False)
            if binding is not None:
                docs.append(binding)
        elif (binding := _skill_binding(row_id, data, name)) is not None:
            skills.append(binding)
    docs.sort(key=lambda d: (d["title"], d["id"]))
    skills.sort(key=lambda d: (d["name"], d["id"]))
    return {"topics": topics, "docs": docs, "skills": skills}


def scan_code_capsules(root: Path, name: Optional[str] = None) -> list[dict[str, Any]]:
    """Source files under ``root`` carrying a ``topic`` capsule (optionally
    filtered to topics within ``name``). Cheap marker check before parsing.
    Returns ``[{path, line, topics: {name: one_liner}}]`` (path root-relative).
    """
    from flow_sdk.capsules.line_comment import COMMENT_LEADERS, LineCommentCapsule  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.walk import gitignore_walk  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for _dir, _subdirs, files in gitignore_walk(root):
        for path in files:
            if path.suffix.casefold() not in COMMENT_LEADERS:
                continue
            try:
                if path.stat().st_size > _MAX_SCAN_FILE_BYTES:
                    continue
                text_content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            marker_at = text_content.find(_CAPSULE_MARKER)
            if marker_at < 0:
                continue
            try:
                capsule = LineCommentCapsule(path).read("topic")
            except Exception:  # noqa: BLE001 — a malformed capsule never breaks reads
                continue
            if capsule is None:
                continue
            bindings = capsule.data.get("topics")
            if not isinstance(bindings, dict):
                continue
            matched = {
                t: line for t, line in sorted(bindings.items())
                if isinstance(t, str) and (name is None or topic_is_within(t, name))
            }
            if not matched:
                continue
            marker_line = text_content.count("\n", 0, marker_at) + 1
            try:
                rel = str(path.relative_to(root))
            except ValueError:
                rel = str(path)
            out.append({"path": rel, "line": marker_line, "topics": matched})
    out.sort(key=lambda item: item["path"])
    return out


async def topic_mentions(topic_id: str) -> list[Any]:
    """Wiki backlinks pointing at a blessed topic. Best-effort: mentions are
    garnish, never load-bearing, so an indexing hiccup returns nothing rather
    than failing the caller."""
    from flow_sdk.wiki.indexer import backlinks  # noqa: PLC0415

    try:
        return await backlinks("topic", topic_id)
    except Exception:  # noqa: BLE001
        return []
