"""Long test: aggregate scan endpoint (slow due to real ~/.claude/ FS scan)."""

from __future__ import annotations

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401


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


async def _create_skill(client, cn_url_base, name: str) -> str:
    resp = await client.post(cn_url_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_scan_aggregate_structure(bootstrapped_client):
    """Aggregate scan returns valid structure (all registered types, including claude types).

    Timeout is long because some registered types (claude_debug_log etc.) read from
    the real ~/.claude/ directory — not isolated to tmp_path.
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
