"""validate-project-name: ask before cloning, not after.

A name clash used to surface only once a repo had already been copied into the
box. Asking first is cheap and lets the user pick another name while nothing has
been written yet — so this action must stay side-effect free.
"""
from pathlib import Path

import pytest

from flow_sdk.config import AGENT_MOUNT_FOLDER


def _cn_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


async def _validate(client, cn_id: str, name: str) -> dict:
    r = await client.post(
        f"/api/v1/graph/compute_node/{cn_id}/validate-project-name",
        json={"name": name},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_free_name_is_available(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    data = await _validate(bootstrapped_client, _cn_id(bootstrap.json()), "totally-unused-name")

    assert data["available"] is True
    assert data["suggested"] == "totally-unused-name"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_taken_name_reports_the_suffix_materialize_would_use(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())
    taken = Path(AGENT_MOUNT_FOLDER) / "occupied-repo"
    taken.mkdir(parents=True, exist_ok=True)

    data = await _validate(bootstrapped_client, cn_id, "occupied-repo")

    assert data["available"] is False
    assert data["suggested"] == "occupied-repo-2"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_validation_writes_nothing(bootstrapped_client):
    """It is a question. Asking it must not create the folder it asks about."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())
    probe = Path(AGENT_MOUNT_FOLDER) / "never-created-by-asking"

    await _validate(bootstrapped_client, cn_id, "never-created-by-asking")

    assert not probe.exists()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_empty_name_is_rejected(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/validate-project-name",
        json={"name": "   "},
    )

    assert r.json()["status"] == "FAIL"
