"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


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
