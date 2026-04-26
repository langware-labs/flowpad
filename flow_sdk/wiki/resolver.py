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

    candidates = await _query_candidates(name)
    if not candidates:
        return dataclasses.replace(link, src_type=src_type, src_id=src_id)

    chosen = _pick_candidate(candidates, src_type)
    return dataclasses.replace(
        link,
        src_type=src_type,
        src_id=src_id,
        target_type=chosen[0],
        target_id=chosen[1],
    )


def _record_name_from_raw(raw: str) -> str:
    """First path segment of `raw`, after stripping link decorations.

    Drops alias `|...`, heading `#...`, block `^...`, the `.md` extension,
    and `./` / `..` segments. Returns the first remaining path segment —
    the record-name candidate.
    """
    s = raw.split("|", 1)[0].split("#", 1)[0].split("^", 1)[0]
    if s.endswith(".md"):
        s = s[:-3]
    parts = [p for p in s.split("/") if p and p not in (".", "..")]
    return parts[0] if parts else s.strip()


async def _query_candidates(name: str) -> list[tuple[str, str]]:
    """Return [(type, id), ...] of all entities whose name matches.

    Tries the indexed `uname` column first, then falls back to the JSON
    `data.name` field. Both queries run on the shared SQLAlchemy engine.
    """
    return await get_async_default_store().find_entities_by_uname_or_name(name)


def _pick_candidate(
    candidates: list[tuple[str, str]], src_type: str
) -> tuple[str, str]:
    """Deterministic precedence:
    1. Same record-type as source first.
    2. Then alphabetical by (type, id).
    """
    candidates_sorted = sorted(candidates)
    for type_, id_ in candidates_sorted:
        if type_ == src_type:
            return (type_, id_)
    return candidates_sorted[0]
