"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

_META_PEEK_BYTES = 8 * 1024


def _meta_field(head: str, key: str) -> str:
    """Value of ``<key>: '…'`` (single- or double-quoted) inside the
    ``export const meta`` literal head; empty string when absent. ``re`` caches
    the compiled pattern, so the two per-file lookups don't re-compile."""
    m = re.search(rf"""\b{re.escape(key)}\s*:\s*(['"])(.*?)\1""", head)
    return m.group(2) if m else ""


def _id_for_path(path: Path) -> str:
    """Stable v5 id from the resolved file path (script authored without an id)."""
    return mint_uuid(f"{RecordType.DYNAMIC_WORKFLOW}:{path.resolve()}", namespace=uuid.NAMESPACE_URL)


def _adopted_id_or_path(path: Path) -> str:
    """Adopt a VALID (v4/v5) ``id`` embedded in the script's ``meta`` block — so a
    shared/copied workflow keeps the SENDER's id and resolves by it on the
    receiver (mirrors skill/agent capsule adoption) — else derive a stable v5
    from the path. Adoption routes through the one sanctioned gate,
    ``adopt_entity_id``, so a foreign/hand-authored id never becomes an entity id.
    """
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(_META_PEEK_BYTES)
    except OSError:
        head = ""
    return adopt_entity_id(_meta_field(head, "id")) or _id_for_path(path)


def dynamic_workflow_id_from_file(ref: FSRef | Path) -> str | None:
    """Read only an embedded valid id; derivation belongs to TypeInfo.mint_id."""
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    path = Path(getattr(ref, "_path", ref))
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:_META_PEEK_BYTES]
    except OSError:
        return None
    return adopt_entity_id(_meta_field(head, "id"))


def dynamic_workflow_identity_key(ref: FSRef | Path) -> str:
    path = Path(getattr(ref, "_path", ref))
    return f"{RecordType.DYNAMIC_WORKFLOW}:{path.resolve()}"


def _read_meta(path: Path) -> tuple[str, str]:
    """(name, description) parsed from the ``export const meta`` literal head."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(_META_PEEK_BYTES)
    except OSError:
        return "", ""
    return _meta_field(head, "name"), _meta_field(head, "description")


def extract_dynamic_workflow(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    return [extract_dynamic_workflow_from_path(ref._path, resolved_id=resolved_id)]


def extract_dynamic_workflow_from_path(path: str | Path, *, resolved_id: str | None = None) -> FSRecord:
    path = Path(path)
    name, description = _read_meta(path)
    rec = FSRecord(
        type=RecordType.DYNAMIC_WORKFLOW,
        id=resolved_id or _adopted_id_or_path(path),
        name=name or path.stem,
        description=description,
        source_file=str(path),
        path=str(path),
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return rec


def dynamic_workflow_default_body(entity) -> str:
    """Starter dynamic-workflow script materialized at asset_ref on create."""
    name = (getattr(entity, "name", None) or "untitled-workflow").strip()
    desc = (getattr(entity, "description", None) or "What this workflow does").strip()
    # Embed the entity id so the script carries its identity: a shared/copied
    # workflow is re-indexed on the receiver and adopts THIS id (see
    # ``_adopted_id_or_path``) instead of minting a fresh path-derived one.
    wf_id = str(getattr(entity, "id", None) or "").strip()
    id_line = f"  id: {wf_id!r},\n" if wf_id else ""
    return (
        "export const meta = {\n"
        f"{id_line}"
        f"  name: {name!r},\n"
        f"  description: {desc!r},\n"
        "  phases: [{ title: 'Main', detail: 'one agent' }],\n"
        "}\n\n"
        "phase('Main')\n"
        "const result = await agent('Describe the task for this agent.')\n"
        "return { result }\n"
    )
