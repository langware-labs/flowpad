"""Long test: aggregate scan endpoint (slow due to real ~/.claude/ FS scan)."""

from __future__ import annotations

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path, monkeypatch):
    """Isolate the records root AND the claude home so the aggregate scan is
    hermetic. Without isolating ``claude_home`` the ``claude_*`` registered
    types (claude_session/codex_session/claude_memory/…) walk the developer's
    real ``~/.claude`` — multi-GB on heavy-usage machines — and the cold scan
    blows the 30s timeout. Pointing FLOWPAD_CLAUDE_HOME at an empty tmp dir
    makes the test deterministic regardless of host ~/.claude size."""
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


async def _create_skill(client, cn_url_base, name: str) -> str:
    resp = await client.post(cn_url_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_scan_aggregate_structure(bootstrapped_client):
    """Aggregate scan returns valid structure (all registered types, including claude types).

    The ``isolate_records_root`` fixture points FLOWPAD_CLAUDE_HOME at an empty
    tmp dir, so the claude_* types walk an empty tree and the scan is hermetic
    (independent of the host's real ~/.claude size).
    """
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "skill-alpha")
    await _create_skill(bootstrapped_client, skill_base, "skill-beta")

    resp = await bootstrapped_client.get(_cn_url(boot, "scan"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    data = body["data"]
    assert "types" in data
    assert "grand_total" in data
    assert "scan_ms" in data
    assert isinstance(data["types"], list)
    assert data["grand_total"] >= 0

    skill_row = next((t for t in data["types"] if t["type"] == "skill"), None)
    assert skill_row is not None
    assert skill_row["count"] >= 2
    assert skill_row["total_bytes"] >= 0
