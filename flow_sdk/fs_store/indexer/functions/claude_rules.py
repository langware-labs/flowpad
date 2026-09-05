"""Extractor + id mint for CLAUDE_RULES records (``<root>/.claude/rules/*.md``).

Discovery is the type's declared ``walk`` (``claude_rules_type_info.py``), run
by the generic ``layout_walker``. Replaces the deleted ``ClaudeRulesRecord``
subclass.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.record_types import RecordType


def _read_rules_frontmatter_id(path: Path) -> str | None:
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
