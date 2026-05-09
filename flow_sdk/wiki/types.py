"""Public dataclasses for the wiki layer."""

from dataclasses import dataclass


@dataclass(frozen=True)
class WikiLink:
    """One occurrence of a wikilink / embed / internal markdown link.

    `raw` is the full inner text between [[ and ]] (or the path of an
    internal markdown link). Alias / heading / block / sub-path are
    derived from `raw` on demand — not stored as separate fields in v1.

    `target_type` / `target_id` are NULL when unresolved.
    `id` is the DB row id; None for in-memory Links not yet persisted.
    """

    raw: str
    line: int
    src_type: str | None = None
    src_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    id: int | None = None
