"""Long tests for fs-records search endpoints (FSIndexer scans all types — slow)."""

from __future__ import annotations

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.fs_store.indexer.functions.task import extract_task
from flow_sdk.fs_store.fs_record import FSRecord
TaskResource = FSRecord  # noqa: F401
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path, monkeypatch):
    # Isolate records root AND claude home so unscoped index/scan stay hermetic
    # and don't materialise real ~/.claude/projects rows into the shared session
    # DB (which would leak into a later unscoped scan). See the matching note in
    # test_fs_records_index_all.py / test_fs_scan_aggregate.py.
    from flow_sdk.instance_settings import reset_instance_settings  # noqa: PLC0415

    claude_home = tmp_path / "claude_home"
    claude_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(claude_home))
    reset_instance_settings()

    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)
    reset_instance_settings()


async def _bootstrap(client):
    resp = await client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return resp.json()


def _cn_url(bootstrap_payload: dict, sub: str) -> str:
    cn_id = bootstrap_payload["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_search_with_query_returns_list(bootstrapped_client):
    """Search with a query string returns a results list (FSIndexer scans all types — slow)."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?q=anything")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    data = body["data"]
    assert "results" in data
    assert "total" in data
    assert "indexer_ready" in data
    assert isinstance(data["results"], list)


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_search_response_has_indexer_ready_flag(bootstrapped_client):
    """indexer_ready is always present in search response."""
    boot = await _bootstrap(bootstrapped_client)
    # With query
    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?q=hello")
    assert resp.status_code == 200
    assert "indexer_ready" in resp.json()["data"]

    # Filter-only browse also propagates indexer_ready
    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?record_type=skill")
    assert resp.status_code == 200
    assert "indexer_ready" in resp.json()["data"]
