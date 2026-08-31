"""DYNAMIC_WORKFLOW extractor + id-gen, against a sample authored .js script."""
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import (
    dynamic_workflow_id,
    extract_dynamic_workflow_from_path,
)

FIXTURE = (
    Path(__file__).parents[1]
    / "fixtures/dynamic_workflows/.claude/workflows/sample-flow.js"
)


def test_extract_meta_from_script():
    rec = extract_dynamic_workflow_from_path(FIXTURE)
    assert rec.type == RecordType.DYNAMIC_WORKFLOW
    assert rec.name == "sample-flow"
    assert rec.description == "A tiny sample dynamic workflow for tests"
    assert rec.source_file.endswith("sample-flow.js")


def test_id_is_stable_valid_entity_id():
    ref = FSRef(FIXTURE, record_type=RecordType.DYNAMIC_WORKFLOW)
    eid = dynamic_workflow_id(ref)
    assert is_valid_entity_id(eid)  # v5 minted from path
    assert dynamic_workflow_id(ref) == eid  # deterministic
