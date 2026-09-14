"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def extract_claude_rules(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    path = ref._path
    rec = FSRecord(
        RecordType.CLAUDE_RULES,
        resolved_id,
        name=path.stem,
        asset_type="rule",
        scope=ref.scope or "user",
    )
    rec.asset_ref = FSRef(path)
    return [rec]
