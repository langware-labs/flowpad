"""Long-running test for the POST /fs-records/index (all types) endpoint.

Moved from tests/api/test_fs_records_scan_search.py because indexing all
registered types (including those that scan ~/.claude/) can take 60–120 s,
causing the full API suite to flake with a 500 under load.

Run manually:
    python -m pytest tests/long_tests/test_fs_records_index_all.py -v -s
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.server.app import app
from flow_sdk.fs_store import get_default_records_root, set_default_records_root

from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401 — register type
from flow_sdk.fs_records.task import TaskResource  # noqa: F401 — register type


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest_asyncio.fixture
async def bootstrapped_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        resp = await c.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cn_url(bootstrap_payload: dict, sub: str) -> str:
    cn_id = bootstrap_payload["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


async def _create_skill(client, cn_url_base, name: str) -> str:
    resp = await client.post(cn_url_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_index_all_returns_total(bootstrapped_client):
    """POST /index (no type) indexes all registered types and returns total.

    Slow because some registered types scan from ~/.claude/ which can contain
    thousands of files on a real machine.
    """
    resp = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    boot = resp.json()
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "bulk-skill")

    resp = await bootstrapped_client.post(_cn_url(boot, "index"))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "indexed" in data
    assert "types" in data
    assert isinstance(data["types"], list)
    assert data["indexed"] >= 1
