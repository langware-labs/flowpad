"""Long test: claude_debug_log fs-records endpoint (slow due to real FS scan)."""

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_fs_records_list_debug_logs(bootstrapped_client):
    """GET /fs-records/claude_debug_log should return sessions with errors."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_debug_log"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert isinstance(body["data"], list)
