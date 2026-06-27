"""Walker + extractor + id mint for WORKFLOW_RUN records.

A Claude Code **workflow run** writes a single-JSON-object journal at
``~/.claude/projects/<slug>/<sessionId>/workflows/wf_<runId>.json``. We treat the
run like a worker transcript/session (worker_type ``"workflow"``): read-only, the
provider owns the file. The extractor reads only the cheap top-level envelope into
the record — the per-agent ``workflowProgress`` payload is NOT walked here (it's
served on demand through the transcript route via the WorkflowParser).
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def workflow_run_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Glob workflow run journals under ``<home>/.claude/projects/*/*/workflows/wf_*.json``.

    Wired for the USER_HOME_FOLDER node only — journals live under ~/.claude,
    never under a project cwd.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        projects = Path(node.path) / ".claude" / "projects"
        if not projects.is_dir():
            continue
        for journal in sorted(projects.glob("*/*/workflows/wf_*.json")):
            key = str(journal.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(journal, record_type=RecordType.WORKFLOW_RUN, parent=node))
    return out


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

    Reuses the skill extractor's own id logic (frontmatter id → uuid5(name)) by
    handing it the ``<name>`` folder (the script's parent)."""
    skill_dir = Path(script_path).parent
    if skill_dir.parent.name != "skills" or skill_dir.parent.parent.name != ".claude" or not skill_dir.is_dir():
        return None
    from flow_sdk.fs_store.indexer.functions.skill import skill_id as _skill_id  # noqa: PLC0415
    return _skill_id(FSRef(skill_dir))


def workflow_run_id(ref: FSRef) -> str:
    """Stable uuid5 from the provider runId (a stable natural key). Doubles as
    the gen_uuid_fn: the journal is provider-owned (read-only), so — unlike
    agent_trace — we never write an id back; uuid5(runId) is stable across
    rescans without persistence."""
    data = _load_journal(ref._path)
    return mint_uuid(_run_id(data, ref._path))


def extract_workflow_run(ref: FSRef) -> list[FSRecord]:
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
    # owning `.claude/skills/<name>/` when bundled in a skill). Derive the
    # DynamicWorkflow id (path-derived, so it matches even if the workflow isn't
    # indexed) and the owning skill id.
    script_path = str(data.get("scriptPath") or "") or None
    dynamic_workflow_id = None
    skill_id = None
    if script_path:
        from flow_sdk.fs_store.indexer.functions.dynamic_workflows import _id_for_path  # noqa: PLC0415
        dynamic_workflow_id = _id_for_path(Path(script_path))
        skill_id = _skill_id_from_path(script_path)

    content_parts = [p for p in (workflow_name, status) if p]
    rec = FSRecord(
        type=RecordType.WORKFLOW_RUN,
        id=mint_uuid(run_id),
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
