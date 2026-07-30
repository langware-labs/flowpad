"""Tag binding readers — the carriers ARE the edge store.

One reader per carrier, each returning ALL bindings (optionally filtered to a
tag subtree). Consumed by both the context route (``flow tag get``) and
the tag graph projection, so the derivation logic lives exactly once.

Carriers:
* markdown frontmatter ``tags:`` → entity rows (``Docs.tags``)
* skill frontmatter ``tags:``    → ``skill.metadata.tags`` (generic dump)
* source-file ``tag`` capsules   → filesystem scan under a root
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from flow_sdk.tags.grammar import normalize_tag, tag_is_within

_CAPSULE_MARKER = "flowpad:capsule tag"
_MAX_SCAN_FILE_BYTES = 2_000_000


def _normalized_tags(values: object) -> list[str]:
    """Canonical taxonomy bindings selected from free-form tag metadata."""
    if not isinstance(values, list):
        return []
    valid: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        try:
            valid.add(normalize_tag(value))
        except (TypeError, ValueError):
            continue
    return sorted(valid)


def _matched(tags: object, name: Optional[str]) -> list[str]:
    valid = _normalized_tags(tags)
    if name is None:
        return valid
    return [t for t in valid if tag_is_within(t, name)]


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
            sa_select(EntitySchema.type, EntitySchema.id, EntitySchema.data).where(EntitySchema.type.in_(types))
        )
        for row_type, row_id, raw in result.all():
            try:
                data = raw if isinstance(raw, dict) else json.loads(raw or "{}")
            except (TypeError, ValueError):
                continue
            out.append((row_type, row_id, data))
    return out


def _doc_binding(row_id: str, data: dict[str, Any], name: Optional[str], with_body: bool) -> Optional[dict[str, Any]]:
    matched = _matched(data.get("tags") or [], name)
    if not matched:
        return None
    binding = {
        "id": row_id,
        "title": data.get("title") or data.get("name") or "",
        "asset_ref": data.get("asset_ref") or "",
        "tags": matched,
    }
    # The body is only for renderers (``flow tag get --mode full``); the
    # graph projection never reads it, so it stays out of that payload.
    if with_body:
        binding["body"] = data.get("body")
    return binding


def _skill_binding(row_id: str, data: dict[str, Any], name: Optional[str]) -> Optional[dict[str, Any]]:
    metadata = data.get("metadata") or {}
    tags = metadata.get("tags") if isinstance(metadata, dict) else None
    matched = _matched(tags or [], name)
    if not matched:
        return None
    return {"id": row_id, "name": data.get("name") or "", "tags": matched}


async def all_doc_bindings(name: Optional[str] = None, *, with_body: bool = True) -> list[dict[str, Any]]:
    """Markdown entities carrying a ``tags`` list (optionally within ``name``)."""
    out = [
        binding
        for _t, row_id, data in await _rows_of_type(("markdown",))
        if (binding := _doc_binding(row_id, data, name, with_body)) is not None
    ]
    out.sort(key=lambda d: (d["title"], d["id"]))
    return out


async def all_skill_bindings(name: Optional[str] = None) -> list[dict[str, Any]]:
    """Skill entities whose frontmatter carried ``tags:`` (rides the generic
    ``skill.metadata`` dump). Returns ``[{id, name, tags}]``."""
    out = [
        binding
        for _t, row_id, data in await _rows_of_type(("skill",))
        if (binding := _skill_binding(row_id, data, name)) is not None
    ]
    out.sort(key=lambda d: (d["name"], d["id"]))
    return out


async def all_entity_bindings(
    name: Optional[str] = None, *, include_assets: bool = True
) -> dict[str, list[dict[str, Any]]]:
    """Every entity-carried binding in ONE scan — ``{tags, docs, skills}``.

    The full graph projection needs all three; going through the per-carrier
    readers would scan the entity table three times for the same rows.
    Tree-only projections pass ``include_assets=False`` to read Tag rows only.
    """
    tags: list[dict[str, Any]] = []
    docs: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    types = ("tag", "markdown", "skill") if include_assets else ("tag",)
    for row_type, row_id, data in await _rows_of_type(types):
        if row_type == "tag":
            tag_name = data.get("name")
            if isinstance(tag_name, str):
                tags.append(
                    {
                        "name": tag_name,
                        "id": row_id,
                        "title": data.get("title"),
                        "description": data.get("description"),
                        "system": bool(data.get("system")),
                    }
                )
        elif row_type == "markdown":
            binding = _doc_binding(row_id, data, name, False)
            if binding is not None:
                docs.append(binding)
        elif (binding := _skill_binding(row_id, data, name)) is not None:
            skills.append(binding)
    docs.sort(key=lambda d: (d["title"], d["id"]))
    skills.sort(key=lambda d: (d["name"], d["id"]))
    return {"tags": tags, "docs": docs, "skills": skills}


def scan_code_capsules(root: Path, name: Optional[str] = None) -> list[dict[str, Any]]:
    """Source files under ``root`` carrying ``tag`` capsules (optionally
    filtered to tags within ``name``). Cheap marker check before parsing.
    Returns ``[{path, line, tags: {name: one_liner}}]`` (path root-relative).

    ONE ENTRY PER BLOCK, not per file: ``tag`` is a repeatable capsule name, so
    a test module annotates each test it carries a breadcrumb for and every
    block reports its own marker line.
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
            if _CAPSULE_MARKER not in text_content:
                continue
            try:
                blocks = LineCommentCapsule(path).read_all("tag")
            except Exception:  # noqa: BLE001 — a malformed capsule never breaks reads
                continue
            if not blocks:
                continue
            try:
                rel = str(path.relative_to(root))
            except ValueError:
                rel = str(path)
            for block in blocks:
                bindings = block.data.data.get("tags")
                if not isinstance(bindings, dict):
                    continue
                matched: dict[str, Any] = {}
                for raw_tag, one_liner in sorted(bindings.items()):
                    if not isinstance(raw_tag, str):
                        continue
                    try:
                        tag = normalize_tag(raw_tag)
                    except (TypeError, ValueError):
                        continue
                    if name is None or tag_is_within(tag, name):
                        matched[tag] = one_liner
                if not matched:
                    continue
                out.append({"path": rel, "line": block.line, "tags": matched})
    out.sort(key=lambda item: (item["path"], item["line"]))
    return out


async def tag_mentions(tag_id: str) -> list[Any]:
    """Wiki backlinks pointing at a blessed tag. Best-effort: mentions are
    garnish, never load-bearing, so an indexing hiccup returns nothing rather
    than failing the caller."""
    from flow_sdk.wiki.indexer import backlinks  # noqa: PLC0415

    try:
        return await backlinks("tag", tag_id)
    except Exception:  # noqa: BLE001
        return []
