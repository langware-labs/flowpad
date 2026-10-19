"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def extract_claude_memory(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    from flow_sdk.assets.types.claude_project_path import _real_path_from_jsonl

    md_path = ref._path
    # encoded project dir: md_path.parent is `memory/`, .parent.parent is the encoded dir
    project_dir = md_path.parent.parent
    encoded = project_dir.name
    real_path = _real_path_from_jsonl(project_dir)
    real = str(real_path) if real_path else "/" + encoded.lstrip("-").replace("-", "/")

    rec = FSRecord(
        RecordType.CLAUDE_MEMORY,
        resolved_id,
        name=md_path.stem,
        asset_type="memory",
        project_path=real,
    )
    rec.asset_ref = FSRef(md_path)
    return [rec]
