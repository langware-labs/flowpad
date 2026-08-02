"""Walker + extractor + id mint for PLAN records.

Emits PLAN records for every `*.md` in `<root>/.claude/plans/`. The default
indexer registers this walker on USER_HOME_FOLDER only because that directory
is Claude Code's own plan-mode store. Flowpad-native and received project Plans
use `agentic-assets/plan/` and are discovered by the repo-assets walker.

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
