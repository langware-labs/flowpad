"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from flow_sdk.assets.frontmatter import _extract_body
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def _extract_name_from_markdown(text: str) -> str | None:
    body = _extract_body(text)
    for line in body.splitlines():
        if not line.startswith("#"):
            continue
        stripped = line.lstrip("#").strip()
        if stripped:
            return stripped
    return None


def extract_claude_plan(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    path = ref._path
    name = path.stem
    try:
        text = path.read_text(encoding="utf-8")
        from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

        text = strip_capsule_blocks(text)
        heading = _extract_name_from_markdown(text)
        if heading:
            name = heading
    except OSError:
        pass
    rec = FSRecord(RecordType.PLAN, resolved_id, name=name, asset_type="plan")
    rec.asset_ref = FSRef(path)
    return [rec]
