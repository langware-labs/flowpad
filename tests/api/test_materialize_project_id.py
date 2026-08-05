"""API tests for materialize-project adopting an id minted off-box.

The hub mints the Project that names an engagement and the box materializes it,
so the SAME id has to span both sides — otherwise the hub asks to make a project
the default and names an id this box has never heard of.

Adoption goes through the entity-id policy gate (v4/v5 only), so a foreign id
(e.g. a hand-authored v7) is refused rather than quietly replaced by a fresh
one: coming back under a different id is the same failure as no project at all.
"""
import uuid
from pathlib import Path

import pytest


def _cn_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


def _staged(tmp_path: Path, name: str = "engagement") -> str:
    """A populated directory standing in for the hub's copy_folder delivery."""
    staging = tmp_path / f"staging-{name}"
    staging.mkdir(parents=True)
    (staging / "README.md").write_text(f"# {name}\n")
    return str(staging)


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_materialize_adopts_a_supplied_v4_id(bootstrapped_client, tmp_path):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())
    wanted = str(uuid.uuid4())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/materialize-project",
        json={"staging_path": _staged(tmp_path), "name": "adopted-v4", "project_id": wanted},
    )

    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["project"]["id"] == wanted
    # The caller's next step is attaching this checkout elsewhere as context,
    # and only the box knows where it landed.
    assert data["path"].endswith("/adopted-v4")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_materialize_adopts_a_supplied_v5_id(bootstrapped_client, tmp_path):
    """v5 = derived from a stable key; just as valid an entity id as v4."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())
    wanted = str(uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/langware-labs/flowpad-hub"))

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/materialize-project",
        json={"staging_path": _staged(tmp_path), "name": "adopted-v5", "project_id": wanted},
    )

    assert r.status_code == 200, r.text
    assert r.json()["data"]["project"]["id"] == wanted


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_materialize_refuses_a_foreign_id(bootstrapped_client, tmp_path):
    """A v7 is a valid UUID and NOT a valid entity id — refuse, don't re-mint."""
    bootstrapped = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrapped.json())
    v7 = "018f4b1e-7c3a-7f2b-9c1d-2e5a6b7c8d9e"

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/materialize-project",
        json={"staging_path": _staged(tmp_path), "name": "foreign-id", "project_id": v7},
    )

    body = r.json()
    assert body["status"] == "FAIL"
    assert "v4" in body["message"] or "v5" in body["message"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_materialize_without_an_id_still_mints_one(bootstrapped_client, tmp_path):
    """The desk path passes no id; it must keep working unchanged."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/materialize-project",
        json={"staging_path": _staged(tmp_path), "name": "minted-here"},
    )

    assert r.status_code == 200, r.text
    assert uuid.UUID(r.json()["data"]["project"]["id"]).version in (4, 5)
