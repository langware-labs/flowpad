"""Extractor + id mint for PLAN records.

Discovery is the type's declared ``walk`` (``plan_type_info.py``): every
`*.md` in `~/.claude/plans/`, Claude Code's own plan-mode store, on the user
root only. Flowpad-native and received project Plans use
`agentic-assets/plan/` and are discovered by the repo-assets walker.

The extractor remains usable by exact-file indexing so a just-written harness
plan can be materialized without a broad user-home walk.

Replaces the deleted ``ClaudePlanRecord`` subclass.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.record_types import RecordType


def _read_plan_frontmatter_id(path: Path) -> str | None:
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

    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else caller derives uuid5(path)


def _extract_name_from_markdown(text: str) -> str | None:
    body = _extract_body(text)
    for line in body.splitlines():
        if not line.startswith("#"):
            continue
        stripped = line.lstrip("#").strip()
        if stripped:
            return stripped
    return None


def _plan_id_from_path(path: Path) -> str:
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(str(path.resolve()))


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
