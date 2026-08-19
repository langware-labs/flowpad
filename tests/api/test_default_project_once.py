"""The provisioned default project reaches exactly one bootstrap.

`initSdk` only honours `default_project` when the client has no project of its
own remembered, so a value that stuck around would keep asserting itself on a
box where the user has since chosen something else. Handing it out once makes it
an opening instruction; everything after that belongs to the user's own picking.

One-shot PER BOX, not per person, and that is a real limit rather than an
oversight: every visitor reaches a sandbox through the same shared cookie-gate
secret, so this side cannot tell a second person from a refresh. Serving a
recipient is the hub's job — it re-arms this instruction before handing someone
the machine (`ComputeNode._rearm_opening_project_for`), and its own tests cover
who gets re-armed. What is pinned here is that the box honours an armed
instruction exactly once, which is what makes that re-arm land.

The bootstrap payload is cached for 30s, which is exactly why the instruction is
stamped per-caller on the way out rather than baked into the cached object —
these tests pin that, because through the cache it would either repeat for 30s
or be skipped entirely.
"""

import uuid
from pathlib import Path

import pytest

from flow_sdk.server.state import _read_opening_project, set_pending_default_project


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
async def test_first_bootstrap_opens_the_provisioned_project_then_forgets_it(bootstrapped_client, tmp_path):
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
    assert _read_opening_project().get("project_id") is None


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
    assert _read_opening_project().get("project_id") is None


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


# do not increase timeout without approval
# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.bootstrap_default_project.rules: FAILING? read this tag's rules
#       before editing — default_project has a strict source order and must stay per-caller,
#       not cached
# flowpad:endcapsule tag
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_with_no_instruction_bootstrap_opens_where_the_user_left_off(bootstrapped_client, tmp_path):
    """A returning user gets the project they were last in, not the @local one.

    The one-shot instruction covers the FIRST open of a provisioned box and
    `initSdk`'s localStorage covers a refresh in the same browser. Neither
    covers the case in between — someone coming back days later, in a browser
    that has never seen this machine — and that is the common way a shared
    sandbox is opened, from a hub link.

    `last_active_at` is the answer and it is already recorded: `activate` (what
    `Project.activateById` posts on every project switch) stamps it server-side.
    Bootstrap simply never reads it, so it falls through to @local.

    Deliberately runs against the WARM bootstrap cache — no invalidation. The
    payload cache is server-owned and 30s long, so the choice has to be stamped
    per-caller in `_with_runtime`, where the pending instruction is already
    stamped. Baked into the cached payload it would serve one caller's project
    to everyone else for the next 30 seconds.
    """
    first = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(first.json())
    local_project_id = _default_project_id(first.json())

    worked_in = await _materialize(bootstrapped_client, cn_id, tmp_path, "course-project")
    assert worked_in != local_project_id

    stamped = await bootstrapped_client.post(f"/api/v1/graph/project/{worked_in}/activate")
    assert stamped.status_code == 200, stamped.text
    assert stamped.json()["data"]["last_active_at"], "activate did not record recency"

    reopened = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert _default_project_id(reopened.json()) == worked_in


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_an_sdk_shipped_system_project_never_becomes_the_opening_project(bootstrapped_client, tmp_path):
    """Reading the shipped assistant's docs must not hijack every later boot.

    `Flowpad Assistant` is a real, browsable project, so opening it stamps
    `last_active_at` exactly like any other. Recency alone would then make it the
    project every fresh browser opens into, permanently — off one glance at its
    docs. `Entity.system` (``entity_model.py:216``) is what separates an
    SDK-shipped project from the user's own, and it is the user's own that
    "where you left off" means.

    The system project is created by the real `_ensure_system_projects`, the same
    function bootstrap itself calls (``bootstrap.py:1364``) — the api fixture does
    not run that leg, and a hand-built row with ``system=True`` would be testing
    the assertion rather than the behaviour. ``system`` is ``Sharing.PRIVATE`` so
    it never reaches the API payload; the entity is the only place to read it.
    """
    from flow_sdk.server.routes.bootstrap import _ensure_system_projects

    first = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(first.json())

    mine = await _materialize(bootstrapped_client, cn_id, tmp_path, "my-work")
    assert (await bootstrapped_client.post(f"/api/v1/graph/project/{mine}/activate")).status_code == 200

    shipped = await _ensure_system_projects()
    assert shipped, "no SDK-shipped system project to test with"
    assert all(p.system for p in shipped), "fixture is not a system project"

    # Opened AFTER the user's own project, so recency alone would pick it.
    for p in shipped:
        assert (await bootstrapped_client.post(f"/api/v1/graph/project/{p.id}/activate")).status_code == 200

    reopened = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    opened = _default_project_id(reopened.json())
    assert opened not in {str(p.id) for p in shipped}
    assert opened == mine
