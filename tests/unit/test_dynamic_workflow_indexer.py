"""DYNAMIC_WORKFLOW walker — emits one record per .claude/workflows/*.js."""
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import dynamic_workflows_fn

# A root whose .claude/workflows/ holds the sample script.
ROOT = Path(__file__).parents[1] / "fixtures/dynamic_workflows"


def test_walker_emits_js_workflows_only():
    node = FSRef(ROOT, record_type=RecordType.PROJECT)
    refs = dynamic_workflows_fn([node], None)
    assert len(refs) == 1
    ref = refs[0]
    assert ref.record_type == RecordType.DYNAMIC_WORKFLOW
    assert ref._path.name == "sample-flow.js"
