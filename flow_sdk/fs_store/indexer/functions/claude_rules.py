"""Walker + extractor + id mint for CLAUDE_RULES records.

Emits CLAUDE_RULES for every `*.md` in `<root>/.claude/rules/`. Register on
USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT; scope inherits via FSRef.

Replaces the deleted ``ClaudeRulesRecord`` subclass.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def claude_rules_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        rules = Path(node.path) / ".claude" / "rules"
        if not rules.is_dir():
            continue
        for md in sorted(rules.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.CLAUDE_RULES, parent=node)
            )
    return out

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
