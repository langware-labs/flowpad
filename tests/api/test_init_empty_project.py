"""init-empty-project: a sandbox project with no repository behind it.

A sandbox is launched WITH a project — usually the one you're working on. When
that project was never cloned from anywhere there is nothing to clone, so it is
mounted empty instead. What makes this more than `mkdir` is identity: a
project's id is resolved from the record whose canonical cwd matches the path
(`project_type_info`: `derived_identity(existing_project_record_id)`), so the
row minted here is what makes a later scan of that directory resolve to THIS
project rather than mint a second one.
"""
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project


def _cn_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


async def _init(client, cn_id: str, name: str, project_id: str | None = None):
    body: dict = {"name": name}
    if project_id is not None:
        body["project_id"] = project_id
    return await client.post(f"/api/v1/graph/compute_node/{cn_id}/init-empty-project", json=body)


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_creates_the_directory_and_a_project_that_points_at_it(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    r = await _init(bootstrapped_client, _cn_id(bootstrap.json()), "empty-engagement")

    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert Path(data["path"]).is_dir()
    assert data["path"].endswith("/empty-engagement")
    assert data["project"]["fs_storage_mount_path"].endswith("/empty-engagement")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_the_directory_resolves_back_to_the_same_project(bootstrapped_client):
    """The point of the row: scanning that path later must not mint a second project."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    r = await _init(bootstrapped_client, _cn_id(bootstrap.json()), "identity-holds")
    data = r.json()["data"]

    found = await Project.find_by_cwd(data["path"])

    assert found is not None
    assert found.id == data["project"]["id"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_adopts_an_id_minted_off_box(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    wanted = str(uuid.uuid4())

    r = await _init(bootstrapped_client, _cn_id(bootstrap.json()), "adopted-empty", wanted)

    assert r.json()["data"]["project"]["id"] == wanted


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_refuses_a_foreign_id(bootstrapped_client):
    """Same adoption gate as materialize: a v7 is a UUID and not an entity id."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    r = await _init(
        bootstrapped_client,
        _cn_id(bootstrap.json()),
        "foreign-empty",
        "018f4b1e-7c3a-7f2b-9c1d-2e5a6b7c8d9e",
    )

    assert r.json()["status"] == "FAIL"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_second_project_of_the_same_name_gets_its_own_folder(bootstrapped_client):
    """Auto-suffix rather than collide — the launch has already paid for a box."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    first = await _init(bootstrapped_client, cn_id, "twice")
    second = await _init(bootstrapped_client, cn_id, "twice")

    first_data, second_data = first.json()["data"], second.json()["data"]
    assert first_data["path"].endswith("/twice")
    assert second_data["path"].endswith("/twice-2")
    assert first_data["project"]["id"] != second_data["project"]["id"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_name_is_required(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    r = await _init(bootstrapped_client, _cn_id(bootstrap.json()), "   ")

    assert r.json()["status"] == "FAIL"
