"""Walker + extractor + id mint for CLAUDE_RULES records.

Emits CLAUDE_RULES for every `*.md` in `<root>/.claude/rules/`. Register on
USER_HOME_FOLDER, REAL_PROJECT_CWD, CWD_ROOT; scope inherits via FSRef.

Replaces the deleted ``ClaudeRulesRecord`` subclass.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
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
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None

def _rule_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))

def claude_rules_id(ref: FSRef) -> str:
    existing = _read_rules_frontmatter_id(ref._path)
    return existing if existing else _rule_id(ref._path)

def claude_rules_gen_id(ref: FSRef) -> str:
    existing = _read_rules_frontmatter_id(ref._path)
    if existing:
        return existing
    new_id = _rule_id(ref._path)
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        return new_id
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        ref._path.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id

def extract_claude_rules(ref: FSRef) -> list[FSRecord]:
    path = ref._path
    rule_id = claude_rules_id(ref)
    rec = FSRecord(
        RecordType.CLAUDE_RULES,
        rule_id,
        name=path.stem,
        asset_type="rule",
        scope=ref.scope or "user",
    )
    rec.asset_ref = FSRef(path)
    return [rec]
