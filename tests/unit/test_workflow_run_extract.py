"""WORKFLOW_RUN indexer extract: read the provider journal envelope into a Record
(summary fields only; the workflowProgress payload stays out of FTS). Read-only —
the journal is provider-owned, so asset_ref is read-only and no id is written back.
"""
from pathlib import Path

import pytest

# Populate the SchemaRegistry so WORKFLOW_RUN type metadata resolves.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.functions.workflow_run import (
    extract_workflow_run,
    workflow_run_id,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_JOURNAL = (
    Path(__file__).resolve().parent
    / "resources" / "transcripts" / "workflows" / "workflows" / "wf_a8e936fe-3a9.json"
)
RUN_ID = "wf_a8e936fe-3a9"


def test_extract_workflow_run_envelope():
    ref = FSRef(_JOURNAL)
    recs = extract_workflow_run(ref, SchemaRegistry.get("workflow_run").mint_entity_id(ref))
    assert len(recs) == 1
    rec = recs[0]

    # Stable v5 id minted from the provider runId.
    assert rec.id == mint_uuid(RUN_ID)
    assert is_valid_entity_id(rec.id)
    assert workflow_run_id(FSRef(_JOURNAL)) == rec.id

    assert rec.run_id == RUN_ID
    assert rec.name == "anatomy-probe"
    assert rec.workflow_name == "anatomy-probe"
    assert rec.status == "completed"
    assert rec.agent_count == 3
    assert rec.total_tokens == 81242
    assert rec.total_tool_calls == 3

    # Envelope only — the workflowProgress payload never enters FTS content.
    assert "workflowProgress" not in (rec.content or "")
    assert "probe1" not in (rec.content or "")


def test_extract_asset_ref_is_read_only():
    ref = FSRef(_JOURNAL)
    rec = extract_workflow_run(ref, SchemaRegistry.get("workflow_run").mint_entity_id(ref))[0]
    ar = getattr(rec, "_asset_ref", None)
    assert ar is not None
    assert ar.read_only is True
    assert Path(ar._path) == _JOURNAL
