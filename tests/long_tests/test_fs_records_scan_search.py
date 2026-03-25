"""Long tests for fs-records search endpoints (FSIndexer scans all types — slow)."""

from __future__ import annotations

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401
from flow_sdk.fs_records.task import TaskResource  # noqa: F401
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


async def _bootstrap(client):
    resp = await client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return resp.json()


def _cn_url(bootstrap_payload: dict, sub: str) -> str:
    cn_id = bootstrap_payload["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


@pytest.mark.asyncio
@pytest.mark.timeout(120)
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
@pytest.mark.timeout(120)
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
