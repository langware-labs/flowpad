"""The provisioned default project reaches exactly one bootstrap.

`initSdk` only honours `default_project` when the client has no project of its
own remembered, so a value that stuck around would keep asserting itself on a
box where the user has since chosen something else. Handing it out once makes it
an opening instruction; everything after that belongs to the user's own picking.

The bootstrap payload is cached for 30s, which is exactly why the instruction is
stamped per-caller on the way out rather than baked into the cached object —
these tests pin that, because through the cache it would either repeat for 30s
or be skipped entirely.
"""
import uuid
from pathlib import Path

import pytest

from flow_sdk.server import state
from flow_sdk.server.state import set_pending_default_project


def _cn_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


def _default_project_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_project"]["id"]


@pytest.fixture(autouse=True)
def _no_pending_default():
    """Leave the module-level instruction clean for the next test either way."""
    set_pending_default_project(None)
    yield
    set_pending_default_project(None)


async def _materialize(client, cn_id: str, tmp_path: Path, name: str) -> str:
    staging = tmp_path / f"staging-{name}"
    staging.mkdir(parents=True)
    (staging / "README.md").write_text(f"# {name}\n")
    r = await client.post(
        f"/api/v1/graph/compute_node/{cn_id}/materialize-project",
        json={"staging_path": str(staging), "name": name},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["project"]["id"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_first_bootstrap_opens_the_provisioned_project_then_forgets_it(
    bootstrapped_client, tmp_path
):
    first = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(first.json())
    local_project_id = _default_project_id(first.json())
    provisioned = await _materialize(bootstrapped_client, cn_id, tmp_path, "engagement")
    assert provisioned != local_project_id

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/set-default-project",
        json={"project_id": provisioned},
    )
    assert r.status_code == 200, r.text

    opened = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert _default_project_id(opened.json()) == provisioned

    # Second load — a refresh, or a second tab — gets the ordinary default back,
    # so it cannot overwrite a choice the user has made in between.
    again = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert _default_project_id(again.json()) == local_project_id


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_without_provisioning_bootstrap_is_unchanged(bootstrapped_client):
    first = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    second = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert _default_project_id(first.json()) == _default_project_id(second.json())


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_set_default_refuses_a_project_this_node_does_not_have(bootstrapped_client):
    """Bootstrap would drop an unknown id silently; the caller must hear about it."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/set-default-project",
        json={"project_id": str(uuid.uuid4())},
    )

    assert r.json()["status"] == "FAIL"
    assert state.pending_default_project_id is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_set_default_refuses_a_foreign_id(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/set-default-project",
        json={"project_id": "018f4b1e-7c3a-7f2b-9c1d-2e5a6b7c8d9e"},  # v7
    )

    assert r.json()["status"] == "FAIL"
    assert state.pending_default_project_id is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_deleted_project_falls_back_instead_of_failing_bootstrap(bootstrapped_client):
    """The instruction is already consumed; landing on the ordinary default
    beats making the box unusable."""
    first = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    local_project_id = _default_project_id(first.json())

    set_pending_default_project(str(uuid.uuid4()))
    opened = await bootstrapped_client.get("/api/v1/graph/bootstrap")

    assert opened.status_code == 200
    assert _default_project_id(opened.json()) == local_project_id
