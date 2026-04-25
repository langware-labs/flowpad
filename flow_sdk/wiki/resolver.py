"""resolve_link — map a parsed WikiLink to a concrete (target_type, target_id).

Queries the `entities` table by `uname` (the record's name as written to disk).
On multiple candidates, applies a deterministic precedence (same-type-as-source
first, alphabetical within tier).

v1 deliberately ignores: folder-as-doc fallthrough, sub-paths beyond the first
segment, headings/blocks/aliases beyond the basename match. All those are
preserved verbatim in `WikiLink.raw` and can be re-resolved later by re-parsing
the column.
"""

from __future__ import annotations

import dataclasses

from .store import get_default_store
from .types import WikiLink


def resolve_link(link: WikiLink, *, src_type: str, src_id: str) -> WikiLink:
    """Return a new WikiLink with src_*/target_* filled.

    Unresolved targets keep target_type/target_id at None.
    """
    name = _record_name_from_raw(link.raw)
    if not name:
        return dataclasses.replace(link, src_type=src_type, src_id=src_id)

    candidates = _query_candidates(name)
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


def _query_candidates(name: str) -> list[tuple[str, str]]:
    """Return [(type, id), ...] of all entities whose name matches.

    Tries the indexed `uname` column first (set by entities that have a
    canonical unique name), then falls back to the `name` field stored
    inside the `data` JSON column (most fs_store records land here today).
    """
    conn = get_default_store()._connection()

    # 1. Indexed uname match (fast path — used by entities that set it).
    rows = conn.execute(
        "SELECT type, id FROM entities WHERE uname = ?",
        (name,),
    ).fetchall()
    if rows:
        return [(row["type"], row["id"]) for row in rows]

    # 2. Fallback: query the JSON `data` column for name field.
    #    SQLite JSON1 extension is built into modern sqlite3.
    rows = conn.execute(
        "SELECT type, id FROM entities WHERE json_extract(data, '$.name') = ?",
        (name,),
    ).fetchall()
    return [(row["type"], row["id"]) for row in rows]


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
