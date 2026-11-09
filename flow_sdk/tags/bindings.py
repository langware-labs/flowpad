"""Tag binding readers — the carriers ARE the edge store.

One reader per carrier, each returning ALL bindings (optionally filtered to a
tag subtree). Consumed by both the context route (``flow tag get``) and
the tag graph projection, so the derivation logic lives exactly once.

Carriers:
* an entity's ``tags`` field — ANY type (a doc's and a skill's come from the
  file header, every other type's from the row; see ``Entity.set_tags``)
* source-file ``tag`` capsules — filesystem scan under a root
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from flow_sdk.tags.grammar import normalize_tag, tag_is_within, to_tags

_CAPSULE_MARKER = "flowpad:capsule tag"
_MAX_SCAN_FILE_BYTES = 2_000_000


def _matched(tags: object, name: Optional[str]) -> list[str]:
    valid = sorted(to_tags(tags))
    if name is None:
        return valid
    return [t for t in valid if tag_is_within(t, name)]


async def _tagged_rows(*, blessed: bool = False, only_type: Optional[str] = None) -> list[tuple[str, str, dict[str, Any]]]:
    """Every row that carries a tag, in ONE scan — ``[(type, id, data), ...]``.

    ``blessed`` adds the ``Tag`` rows themselves (the taxonomy's own entities).
    A single query on purpose: inside a request all ``session()`` blocks share one
    AsyncSession, so separate reads cannot run concurrently anyway.
    """
    from sqlalchemy import text  # noqa: PLC0415

    from flow_sdk.db import session as _session  # noqa: PLC0415

    where = "json_array_length(json_extract(data, '$.tags')) > 0"
    params: dict[str, Any] = {}
    if only_type:
        where = f"type = :only_type AND {where}"
        params["only_type"] = only_type
    if blessed:
        where = f"type = 'tag' OR ({where})"
    out: list[tuple[str, str, dict[str, Any]]] = []
    async with _session(write=False) as s:
        result = await s.execute(text(f"SELECT type, id, data FROM entities WHERE {where}"), params)
        for row_type, row_id, raw in result.all():
            try:
                data = raw if isinstance(raw, dict) else json.loads(raw or "{}")
            except (TypeError, ValueError):
                continue
            out.append((row_type, row_id, data))
    return out


def _binding(row_type: str, row_id: str, data: dict[str, Any], name: Optional[str]) -> Optional[dict[str, Any]]:
    matched = _matched(data.get("tags") or [], name)
    if not matched:
        return None
    return {
        "type": row_type,
        "id": row_id,
        "title": data.get("title") or data.get("name") or "",
        "asset_ref": data.get("asset_ref") or "",
        "tags": matched,
    }


def _by_title(bindings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(bindings, key=lambda b: (b["type"], b["title"], b["id"]))


async def all_doc_bindings(name: Optional[str] = None) -> list[dict[str, Any]]:
    """Markdown docs carrying a tag (optionally within ``name``), each with its
    stored ``body`` — what ``flow tag get`` summarises."""
    out = []
    for row_type, row_id, data in await _tagged_rows(only_type="markdown"):
        binding = _binding(row_type, row_id, data, name)
        if binding is not None:
            out.append({**binding, "body": data.get("body")})
    return _by_title(out)


async def all_entity_bindings(
    name: Optional[str] = None, *, include_assets: bool = True
) -> dict[str, list[dict[str, Any]]]:
    """The blessed ``Tag`` rows and every tagged entity — ``{tags, entities}``.

    Tree-only projections pass ``include_assets=False`` to read Tag rows only.
    """
    tags: list[dict[str, Any]] = []
    entities: list[dict[str, Any]] = []
    for row_type, row_id, data in await _tagged_rows(blessed=True, only_type=None if include_assets else "tag"):
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
        elif (binding := _binding(row_type, row_id, data, name)) is not None:
            entities.append(binding)
    return {"tags": tags, "entities": _by_title(entities)}


async def tag_names() -> list[str]:
    """Every tag name worth suggesting where a person classifies something: the ones in
    use and the ones a person blessed. The shipped system vocabulary is left out — it is
    mostly event names (``entity.created``), which nobody tags a thing with."""
    from sqlalchemy import text  # noqa: PLC0415

    from flow_sdk.db import session as _session  # noqa: PLC0415

    in_use = "SELECT j.value FROM entities, json_each(entities.data, '$.tags') AS j"
    blessed = (
        "SELECT json_extract(data, '$.name') FROM entities WHERE type = 'tag'"
        " AND NOT COALESCE(json_extract(data, '$.deprecated'), 0)"
        " AND NOT COALESCE(json_extract(data, '$.system'), 0)"
    )
    async with _session(write=False) as s:
        rows = (await s.execute(text(f"{in_use} UNION {blessed}"))).all()
    return to_tags([name for (name,) in rows])


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
    from flow_sdk.wiki import backlinks  # noqa: PLC0415

    try:
        return await backlinks("tag", tag_id)
    except Exception:  # noqa: BLE001
        return []
