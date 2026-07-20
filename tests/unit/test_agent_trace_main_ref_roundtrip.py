"""AgentTrace owns_main_ref round-trip: create materializes trace.json, a
metadata-only save (no payload) never clobbers it, extraction reads back the
summary fields only.
"""
import json
from types import SimpleNamespace

import pytest

# Populate the SchemaRegistry so compute_asset_ref/default_body resolve AGENT_TRACE.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.agent_trace import extract_agent_trace
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

TRACE_ID = "7f3a2c10-5b1e-4d6a-9c2f-8e4b0a1d3c55"
SESSION_ID = "11111111-1111-4111-8111-111111111111"


def _payload() -> dict:
    return {
        "version": 1,
        "id": None,
        "name": "trace-1111",
        "session_id": SESSION_ID,
        "worker_type": "claude",
        "summary": {
            "verdict": "mixed", "verdict_reason": "one stuck loop",
            "duration_ms": 120000, "cost_usd": 1.25,
            "issue_count": 3, "divergence_count": 1, "lane_count": 2,
            "tool_call_count": 40,
        },
        "lanes": [], "events": [], "markers": [],
        "annotations": {"goals": [], "divergences": [], "verdict": "mixed", "notes": []},
    }


def _trace_entity(trace: dict | None):
    return SimpleNamespace(id=TRACE_ID, name="trace-1111", trace=trace)


def test_agent_trace_main_ref_roundtrip(tmp_path):
    entity = _trace_entity(_payload())
    rec = FSRecord(type=RecordType.AGENT_TRACE, id=TRACE_ID)
    ar = rec.compute_asset_ref(tmp_path, entity)
    assert ar is not None, "AGENT_TRACE must declare main_subdir/main_layout"
    object.__setattr__(rec, "_asset_ref", ar)

    # 1. Create writes .claude/agent_traces/<name>/trace.json with the payload
    #    and the entity id injected.
    rec.upsert_main_ref(entity)
    doc = ar._path
    assert doc.name == "trace.json", f"expected inner trace.json, got {doc}"
    assert doc.parent.parent.name == "agent_traces"
    written = json.loads(doc.read_text(encoding="utf-8"))
    assert written["id"] == TRACE_ID
    assert written["summary"]["verdict"] == "mixed"

    # 2. Extraction reads summary fields only — payload stays out of FTS.
    ref = FSRef(doc)
    recs = extract_agent_trace(ref, SchemaRegistry.get("agent_trace").mint_id(ref))
    assert len(recs) == 1
    out = recs[0]
    assert out.id == TRACE_ID
    assert out.session_id == SESSION_ID
    assert out.verdict == "mixed"
    assert out.issue_count == 3
    assert out.lane_count == 2
    assert "lanes" not in (out.content or "")

    # 3. A metadata-only save (entity without payload) must NOT clobber the
    #    file even though owns_main_ref is True — default_body_fn returns None.
    entity2 = _trace_entity(None)
    rec.upsert_main_ref(entity2)
    after = json.loads(doc.read_text(encoding="utf-8"))
    assert after == written, "payload-less save clobbered trace.json"

    # 4. A save WITH a new payload re-renders (the entity owns the file).
    new_payload = _payload()
    new_payload["summary"]["verdict"] = "ok"
    rec.upsert_main_ref(_trace_entity(new_payload))
    assert json.loads(doc.read_text(encoding="utf-8"))["summary"]["verdict"] == "ok"
