"""Walker + extractor + id mint for PROMPT records (docs/prompt-library.md).

Prompts live at ``<project>/prompts/<name>.md`` — YAML frontmatter for
metadata (``name``/``icon``/``color``/optional ``group_id``; the ``queue``
block is reserved for v1.1 enqueue flags and intentionally stays file-only),
body = the prompt text. Mirrors the SPEC recipe in ``spec.py``.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def prompt_project_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        prompts_root = Path(node.path) / "prompts"
        if not prompts_root.is_dir():
            continue
        for md in sorted(prompts_root.glob("*.md")):
            if not md.is_file():
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.PROMPT, parent=node))
    return out


def _prompt_id_from_path(path: Path) -> str:
    """UUID5 from resolved path — stable across rescans."""
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(str(path.resolve()))


def _prompt_frontmatter(path: Path) -> dict:
    """Parsed frontmatter dict, or {} (never raises)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    fields = _yaml_load(fm)
    return fields if isinstance(fields, dict) else {}


def _read_prompt_frontmatter_id(path: Path) -> str | None:
    """Return a validated ``id`` from frontmatter, or None.

    Validate-on-adopt (entity-id policy): anything that isn't UUID v4/v5 is
    ignored so a hand-authored foreign id can never become an entity id —
    the caller derives the stable uuid5(path) instead.
    """
    raw = _prompt_frontmatter(path).get("id")
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    return adopt_entity_id(raw)


def prompt_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_prompt_frontmatter_id(ref._path)
    return existing if existing else _prompt_id_from_path(ref._path)


def extract_prompt(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a ``prompts/<name>.md`` into a PROMPT record.

    Frontmatter ``name`` falls back to the file stem; ``icon``/``color`` are
    optional; an optional ``group_id`` (validated v4/v5) places the prompt in
    a library folder. The body is the prompt ``text``.
    """
    path = ref._path
    fields = _prompt_frontmatter(path)
    name = str(fields.get("name") or path.stem)
    icon = fields.get("icon")
    color = fields.get("color")

    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    group_id = adopt_entity_id(fields.get("group_id"))

    try:
        from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

        body = _extract_body(strip_capsule_blocks(path.read_text(encoding="utf-8")))
    except OSError:
        body = ""

    extra: dict = {}
    if icon is not None:
        extra["icon"] = str(icon)
    if color is not None:
        extra["color"] = str(color)
    if group_id:
        extra["group_id"] = group_id
    # Usage tracking round-trips through frontmatter so a reindex doesn't
    # reset it (junk values are ignored, not coerced into errors).
    try:
        extra["use_count"] = int(fields.get("use_count", 0) or 0)
    except (TypeError, ValueError):
        pass
    last_used_at = fields.get("last_used_at")
    if isinstance(last_used_at, datetime):  # YAML parses bare timestamps as datetime
        extra["last_used_at"] = last_used_at.isoformat().replace("+00:00", "Z")
    elif isinstance(last_used_at, str) and last_used_at:
        extra["last_used_at"] = last_used_at
    rec = FSRecord(
        type=RecordType.PROMPT,
        id=resolved_id,
        name=name,
        text=body.strip(),
        **extra,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
