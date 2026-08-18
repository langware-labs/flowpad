"""WORKFLOW_RUN lineage — the journal's scriptPath is captured + resolved to
the source DynamicWorkflow id and (when bundled) the owning skill id."""
import json
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.workflow_run import extract_workflow_run
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import _id_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _journal(path: Path, script_path: Path) -> Path:
    path.write_text(json.dumps({
        "runId": "wf_lineage_test",
        "workflowName": "demo-skill-flow",
        "status": "completed",
        "agentCount": 1,
        "scriptPath": str(script_path),
    }))
    return path


def _rec(journal: Path):
    ref = FSRef(journal, record_type=RecordType.WORKFLOW_RUN)
    return extract_workflow_run(ref, SchemaRegistry.get("workflow_run").mint_entity_id(ref, derive=True, overwrite=True))[0]


def test_skill_bundled_run_links_to_workflow_and_skill(tmp_path):
    skill_dir = tmp_path / ".claude/skills/demo-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: demo-skill\n---\n# demo-skill\n")
    flow = skill_dir / "flow.js"
    flow.write_text("export const meta = { name: 'demo-skill-flow' }\n")

    rec = _rec(_journal(tmp_path / "wf.json", flow))
    assert rec.source_path == str(flow)
    assert rec.dynamic_workflow_id == _id_for_path(flow)
    assert is_valid_entity_id(rec.dynamic_workflow_id)
    assert is_valid_entity_id(rec.skill_id)
    assert SchemaRegistry.get("skill").mint_entity_id(FSRef(skill_dir)) == rec.skill_id


def test_standalone_workflow_run_has_no_skill(tmp_path):
    wf_dir = tmp_path / ".claude/workflows"
    wf_dir.mkdir(parents=True)
    flow = wf_dir / "x.js"
    flow.write_text("export const meta = { name: 'x' }\n")

    rec = _rec(_journal(tmp_path / "wf.json", flow))
    assert rec.dynamic_workflow_id == _id_for_path(flow)
    assert rec.skill_id is None
