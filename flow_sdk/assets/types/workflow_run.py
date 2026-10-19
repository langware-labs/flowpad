"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def _load_journal(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _run_id(data: dict, path: Path) -> str:
    """The provider runId (``wf_<...>``); falls back to the filename stem."""
    return str(data.get("runId") or path.stem)


def _skill_id_from_path(script_path: str) -> str | None:
    """The owning skill's id when ``script_path`` is a ``.claude/skills/<name>/*.js``.

    Resolves through the skill type's read-only identity seam. Reading a run
    never stamps or otherwise mutates the referenced skill."""
    skill_dir = Path(script_path).parent
    if skill_dir.parent.name != "skills" or skill_dir.parent.parent.name != ".claude" or not skill_dir.is_dir():
        return None
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.SKILL))
    if info is None:
        return None

    try:
        ref = FSRef(skill_dir, record_type=RecordType.SKILL)
        return info.read_identity(info.layout_for(ref), ref=ref)
    except Exception:
        return None


def workflow_run_identity_key(ref: FSRef | Path) -> str:
    path = Path(getattr(ref, "_path", ref))
    return _run_id(_load_journal(path), path)


def extract_workflow_run(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a wf_<runId>.json journal into a Record — envelope fields only.

    FTS content is the workflow name + status; the workflowProgress payload
    never enters the index.
    """
    path = ref._path
    data = _load_journal(path)
    run_id = _run_id(data, path)
    workflow_name = str(data.get("workflowName") or run_id)
    status = str(data.get("status") or "")

    # Lineage: the journal records the source workflow's `.js` path (incl. the
    # owning `.claude/skills/<name>/` when bundled in a skill). Two cross-refs:
    #  - dynamic_workflow_id: PATH-derived by design — a `.js` script carries no
    #    capsule (no frontmatter, no `.flow/id`), so its id has no portable home;
    #    the path derive is the only stable key, not the collision anti-pattern.
    #  - skill_id: read through the owning skill's TypeInfo, so this reference
    #    follows canonical and legacy identity without minting the other asset.
    script_path = str(data.get("scriptPath") or "") or None
    dynamic_workflow_id = None
    skill_id = None
    if script_path:
        from flow_sdk.assets.types.dynamic_workflows import _id_for_path
        dynamic_workflow_id = _id_for_path(Path(script_path))
        skill_id = _skill_id_from_path(script_path)

    content_parts = [p for p in (workflow_name, status) if p]
    rec = FSRecord(
        type=RecordType.WORKFLOW_RUN,
        id=resolved_id,
        name=workflow_name,
        run_id=run_id,
        workflow_name=workflow_name,
        status=status,
        agent_count=data.get("agentCount") or 0,
        total_tokens=data.get("totalTokens") or 0,
        total_tool_calls=data.get("totalToolCalls") or 0,
        duration_ms=data.get("durationMs"),
        default_model=str(data.get("defaultModel") or "") or None,
        source_path=script_path,
        dynamic_workflow_id=dynamic_workflow_id,
        skill_id=skill_id,
        content="\n".join(content_parts),
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True))
    return [rec]
