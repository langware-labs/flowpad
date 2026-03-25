"""API tests for the get-cwd endpoint on ComputeNode.

These tests hit the real endpoint — no mocking.
"""
import pytest


def _get_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_get_cwd_returns_success(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/get-cwd")
    assert r.status_code == 200
    payload = r.json()
    assert payload["status"] == "SUCCESS"
    assert "cwd" in payload["data"]


@pytest.mark.asyncio
async def test_get_cwd_returns_nonempty_path(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/get-cwd")
    cwd = r.json()["data"]["cwd"]
    assert isinstance(cwd, str)
    assert len(cwd) > 0
    assert cwd.startswith("/")  # pwd always returns an absolute path on Unix
