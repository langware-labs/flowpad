"""resolve_link — map a parsed WikiLink to a concrete (target_type, target_id).

Queries the `entities` table by `uname` (the record's name as written to disk)
via the shared SQLAlchemy engine. On multiple candidates, applies a
deterministic precedence (same-type-as-source first, alphabetical within tier).

v1 deliberately ignores: folder-as-doc fallthrough, sub-paths beyond the first
segment, headings/blocks/aliases beyond the basename match. All those are
preserved verbatim in `WikiLink.raw` and can be re-resolved later by re-parsing
the column.
"""

from __future__ import annotations

import dataclasses

from .store import get_async_default_store
from .types import WikiLink


async def resolve_link(link: WikiLink, *, src_type: str, src_id: str) -> WikiLink:
    """Return a new WikiLink with src_*/target_* filled.

    Unresolved targets keep target_type/target_id at None.
    """
    name = _record_name_from_raw(link.raw)
    if not name:
        return dataclasses.replace(link, src_type=src_type, src_id=src_id)

    scoped = await _resolve_scoped(link, name, src_type, src_id)
    if scoped is not None:
        from flow_sdk.fs_store.type_id import TypeId

        target_raw = scoped.get("target_typeid") if scoped.get("kind") == "resolved" else None
        target = TypeId(target_raw) if target_raw else None
        return dataclasses.replace(
            link,
            src_type=src_type,
            src_id=src_id,
            target_type=target.type if target else None,
            target_id=target.id if target else None,
        )

    # Compatibility for unscoped legacy rows/tests: retain unique global
    # resolution, but never use the old same-type/alphabetical ambiguity rule.
    from .service import resolve_legacy_unscoped

    legacy = await resolve_legacy_unscoped(name)
    target_raw = legacy.get("target_typeid") if legacy.get("kind") == "resolved" else None
    if target_raw is None:
        return dataclasses.replace(link, src_type=src_type, src_id=src_id)
    from flow_sdk.fs_store.type_id import TypeId

    target = TypeId(target_raw)

    return dataclasses.replace(
        link,
        src_type=src_type,
        src_id=src_id,
        target_type=target.type,
        target_id=target.id,
    )


def _record_name_from_raw(raw: str) -> str:
    """First path segment of `raw`, after stripping link decorations.

    Drops alias `|...`, heading `#...`, block `^...`, the `.md` extension,
    and `./` / `..` segments. Returns the first remaining path segment —
    the record-name candidate.
    """
    from .parser import canonicalize_word

    try:
        return canonicalize_word(raw)
    except ValueError:
        return ""


async def _resolve_scoped(
    link: WikiLink,
    name: str,
    src_type: str,
    src_id: str,
) -> dict | None:
    """Resolve through an explicit Wiki or the source Project's default Wiki.

    None means the source lacks project context, so the legacy unique-only
    compatibility lookup may run.
    """
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.builtin.wiki import Wiki
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    from .service import ensure_default_wiki, resolve

    wiki = None
    if link.wiki_ref and link.wiki_ref != "@local":
        wiki = await Wiki.get_by_typeid(TypeId(f"wiki-{link.wiki_ref}"))
    else:
        source_model = SchemaRegistry.get_entity_cls(src_type)
        source = await source_model.get_one({"id": src_id}) if source_model else None
        project_id = getattr(source, "project_id", None) if source is not None else None
        if project_id:
            from flow_sdk.builtin.project import Project

            project = await Project.get_by_id(str(project_id))
            if project is not None:
                wiki = await ensure_default_wiki(project)
        elif link.wiki_ref == "@local":
            return {"kind": "missing"}

    return await resolve(wiki, name) if wiki is not None else None


async def _query_candidates(name: str) -> list[tuple[str, str]]:
    """Return [(type, id), ...] of all entities whose name matches.

    Tries the indexed `uname` column first, then falls back to the JSON
    `data.name` field. Both queries run on the shared SQLAlchemy engine.
    """
    return await get_async_default_store().find_entities_by_uname_or_name(name)
