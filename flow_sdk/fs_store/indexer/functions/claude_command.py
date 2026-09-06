"""Extractor + id mint for COMMAND records (``<root>/.claude/commands/*.md``).

Discovery is the type's declared ``walk`` (``command_type_info.py``), run by
the generic ``layout_walker``. Replaces the deleted ``ClaudeCommandFsRecord``
subclass.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.record_types import RecordType


def _read_command_frontmatter_id(path: Path) -> str | None:
    """Adopt a valid (v4/v5) ``id:`` from the command's YAML frontmatter, else
    None. Lets a SHARED command (whose sender id is pinned into frontmatter)
    materialize under the SAME id on the receiver instead of a fresh uuid5."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    raw = fields.get("id") or fields.get("asset_id")
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(raw)


def _command_id_from_key(ref: FSRef) -> str:
    scope = ref.scope or "user"
    return mint_uuid(
        f"{RecordType.COMMAND}:{scope}:{ref._path.stem}",
        namespace=uuid.NAMESPACE_DNS,
    )


def command_identity_key(ref: FSRef | Path) -> str:
    """Natural key passed to the canonical UUID minter."""
    path = Path(getattr(ref, "_path", ref))
    scope = getattr(ref, "scope", None) or "user"
    return f"{RecordType.COMMAND}:{scope}:{path.stem}"


def extract_claude_command(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a single ``.md`` command file into a Record.

    Replaces ``ClaudeCommandFsRecord._from_fsref_sync``. The record is a base
    ``Record`` instance — no subclass needed. Returns an empty list if the
    file can't be read.
    """
    md_file = ref._path
    try:
        content = md_file.read_text(encoding="utf-8")
    except OSError:
        return []
    from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

    content = strip_capsule_blocks(content)
    scope = ref.scope or "user"
    command_name = md_file.stem
    rec = FSRecord(
        type=RecordType.COMMAND,
        id=resolved_id,
        name=command_name,
        command_name=command_name,
        content=content,
        scope=scope,
    )
    rec.source_file = str(md_file)
    object.__setattr__(rec, "_asset_ref", FSRef(md_file))
    return [rec]
