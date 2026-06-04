"""Walker + extractor + id mint for PLAN records.

Emits PLAN records for every `*.md` in `<root>/.claude/plans/`. Layout is
identical across user, project, and cwd roots — register this one function
on USER_HOME_FOLDER, REAL_PROJECT_CWD, and CWD_ROOT; scope inherits from
whichever root the call chain started at.

Replaces the deleted ``ClaudePlanRecord`` subclass.
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

def claude_plan_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        plans = Path(node.path) / ".claude" / "plans"
        if not plans.is_dir():
            continue
        for md in sorted(plans.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.PLAN, parent=node))
    return out

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
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
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
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))

def claude_plan_id(ref: FSRef) -> str:
    """Cheap id: frontmatter id; else uuid5 of path."""
    existing = _read_plan_frontmatter_id(ref._path)
    return existing if existing else _plan_id_from_path(ref._path)

def claude_plan_gen_id(ref: FSRef) -> str:
    """Mint+write id into frontmatter (idempotent). Same shape as the
    deleted ``ClaudePlanRecord.genId``. Preserves derived uuid5(path)."""
    existing = _read_plan_frontmatter_id(ref._path)
    if existing:
        return existing
    new_id = _plan_id_from_path(ref._path)
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

def extract_claude_plan(ref: FSRef) -> list[FSRecord]:
    path = ref._path
    plan_id = claude_plan_id(ref)
    name = path.stem
    try:
        text = path.read_text(encoding="utf-8")
        heading = _extract_name_from_markdown(text)
        if heading:
            name = heading
    except OSError:
        pass
    rec = FSRecord(RecordType.PLAN, plan_id, name=name, asset_type="plan")
    rec.asset_ref = FSRef(path)
    return [rec]
