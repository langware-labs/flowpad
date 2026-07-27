"""create-group-task / sync-group integration (hub boundary faked).

Exercises the real action handlers over the in-process ASGI app: parent task +
contacts group are created through the normal graph routes, then the group
fan-out runs with `share`/`create_child`/`hub_post`/`hub_put`/`hub_get` faked
at their source modules. Asserts the plan's contract: title-only clone, deduped
member rows keyed (parent_id, assignee), child-first invitation targets with
editor/guest roles, idempotent re-run, and owner-side member-field sync (LWW).
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task, TaskKind

pytestmark = pytest.mark.asyncio

GRAPH = "/api/v1/graph"


class _FakeCreds:
    api_key = "test-key"
    user = {"email": "owner@x.com"}


@pytest.fixture
def _blob_storage(tmp_path):
    """Task.description is a blob → get_one's expand_blobs needs embedded
    storage. The in-process ASGI harness has no request-scoped storage
    (middleware wiring is intentionally disabled), so install the same dev
    storage fallback production falls back to (test_flow_message_actions
    pattern)."""
    import shutil

    from flow_sdk.config import default_service_config
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    blob_root = tmp_path / "task_blobs"
    blob_root.mkdir(parents=True, exist_ok=True)
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(blob_root)))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        shutil.rmtree(blob_root, ignore_errors=True)


@pytest.fixture
def hub_faked(_blob_storage, monkeypatch):
    """Fake every hub touchpoint the group-task actions use."""
    posts: list[tuple[str, dict]] = []
    puts: list[tuple[str, dict]] = []
    created_children: list[tuple[str, str]] = []

    async def fake_share(self, *, recursive=False):
        self.remote = True
        return self

    async def fake_create_child(self, child):
        created_children.append((self.id, child.id))
        child.remote = True
        return child

    # Record hub writes as the (path, payload) the real transport would issue,
    # so assertions keep reading like the wire contract.
    async def fake_hub_post(entity_type, payload, entity_id=None, action=None, *a, **k):
        etype = getattr(entity_type, "value", entity_type)
        posts.append((f"/graph/{etype}/{entity_id}/{action}", payload))
        return {}

    async def fake_hub_put(entity_type, entity_id, payload, *a, **k):
        etype = getattr(entity_type, "value", entity_type)
        puts.append((f"/graph/{etype}/{entity_id}", payload))
        return {}

    import flow_sdk.app.actions.group_task_action as gta
    import flow_sdk.cli.auth.credentials as creds_mod
    import flow_sdk.cli.auth.hub_login as login_mod

    monkeypatch.setattr(creds_mod, "load_credentials", lambda *a, **k: _FakeCreds())
    monkeypatch.setattr(login_mod, "is_logged_in", lambda: True)
    monkeypatch.setattr(gta, "hub_post", fake_hub_post)
    monkeypatch.setattr(gta, "hub_put", fake_hub_put)
    monkeypatch.setattr(gta, "_local_mode_share_blocked", lambda: False)
    monkeypatch.setattr(Task, "share", fake_share)
    monkeypatch.setattr(Task, "create_child", fake_create_child)
    return {"posts": posts, "puts": puts, "children": created_children}


async def _create(client, type_name: str, body: dict) -> dict:
    resp = await client.post(f"{GRAPH}/{type_name}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_create_group_task_fans_out_and_is_idempotent(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Ship It"})
    group = await _create(
        bootstrapped_client,
        "contacts_group",
        {
            "type": "contacts_group",
            "name": "Team",
            "contacts": [
                {"email": "bob@x.com", "name": "Bob"},
                {"email": "carol@x.com"},
                {"email": "owner@x.com"},  # the owner — must be dropped
                {"name": "No Email"},  # email-less — reported in failed[]
            ],
        },
    )

    resp = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert sorted(data["created"]) == ["bob@x.com", "carol@x.com"]
    assert data["skipped"] == []
    assert len(data["failed"]) == 1 and "No Email" in data["failed"][0]["error"]

    # Parent flipped to group and shared.
    parent_row = await Task.get_one({"id": parent["id"]})
    assert parent_row.kind == TaskKind.GROUP.value
    assert parent_row.remote is True

    # Children: title-only clone, member identity, hub child creation.
    children = await Task.get_all({"parent_id": parent["id"]})
    assert len(children) == 2
    by_assignee = {c.assignee: c for c in children}
    assert set(by_assignee) == {"bob@x.com", "carol@x.com"}
    for c in children:
        assert c.title == "Ship It"
        assert c.kind == TaskKind.STANDARD.value
        assert c.status == "to_do"
        assert c.remote is True
    assert len(hub_faked["children"]) == 2  # created via create_child (is_child edge)

    # One invitation per member: child target FIRST (editor), parent guest.
    member_posts = [p for p in hub_faked["posts"] if p[0].endswith("/members")]
    assert len(member_posts) == 2
    for path, body in member_posts:
        child = by_assignee[body["recipient_email"]]
        assert path == f"/graph/task/{child.id}/members"
        targets = body["invitation_targets"]
        assert targets[0] == {"typeid": f"task-{child.id}", "role": "editor"}
        assert targets[1] == {"typeid": f"task-{parent['id']}", "role": "guest"}

    # Idempotent re-run: nothing new, both skipped (invites re-attempted).
    resp2 = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]}
    )
    data2 = resp2.json()["data"]
    assert data2["created"] == []
    assert sorted(data2["skipped"]) == ["bob@x.com", "carol@x.com"]
    assert len(await Task.get_all({"parent_id": parent["id"]})) == 2


async def test_assign_task_gives_the_task_to_one_owner(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Fix Login"})

    resp = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/assign-task",
        json={"email": "Bob@X.com", "name": "Bob", "message": "please take a look"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert (data["self"], data["created"], data["assignee"]) == (False, True, "bob@x.com")

    # The owner surface: assignee + reporter stamped, overview named after the
    # person, shared to the hub.
    parent_row = await Task.get_one({"id": parent["id"]})
    assert parent_row.assignee == "bob@x.com"
    assert parent_row.reporter == "owner@x.com"
    assert (parent_row.kind, parent_row.group_name, parent_row.remote) == (TaskKind.GROUP.value, "Bob", True)

    # Exactly one member task — title-only clone keyed to the assignee.
    children = await Task.get_all({"parent_id": parent["id"]})
    assert len(children) == 1
    child = children[0]
    assert data["child"] == str(child.typeid)
    assert (child.assignee, child.title, child.status) == ("bob@x.com", "Fix Login", "to_do")
    assert len(hub_faked["children"]) == 1  # is_child edge created on the hub

    # One invitation carrying the caller's message; child target first (editor).
    member_posts = [p for p in hub_faked["posts"] if p[0].endswith("/members")]
    assert len(member_posts) == 1
    path, body = member_posts[0]
    assert path == f"/graph/task/{child.id}/members"
    assert body["recipient_email"] == "bob@x.com"
    assert body["message"] == "please take a look"
    assert body["invitation_targets"] == [
        {"typeid": f"task-{child.id}", "role": "editor"},
        {"typeid": f"task-{parent['id']}", "role": "guest"},
    ]


async def test_assign_task_is_idempotent(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Again"})
    first = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/assign-task", json={"email": "bob@x.com"}
    )
    child_typeid = first.json()["data"]["child"]

    again = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/assign-task", json={"email": "bob@x.com"}
    )
    data = again.json()["data"]
    assert data["created"] is False, "re-assigning the same person reuses their member task"
    assert data["child"] == child_typeid
    assert len(await Task.get_all({"parent_id": parent["id"]})) == 1


async def test_assign_task_to_self_stays_local(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Mine"})

    resp = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/assign-task", json={"email": "owner@x.com"}
    )
    assert resp.json()["data"] == {"child": None, "self": True, "created": False, "assignee": "owner@x.com"}

    parent_row = await Task.get_one({"id": parent["id"]})
    assert parent_row.assignee == "owner@x.com"
    assert parent_row.kind != TaskKind.GROUP.value, "assigning to yourself is not a group"
    assert await Task.get_all({"parent_id": parent["id"]}) == []
    assert hub_faked["posts"] == [], "nothing is sent to the hub"


async def test_assign_task_rejects_member_task_and_missing_email(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "T"})
    await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/assign-task", json={"email": "bob@x.com"})
    child = (await Task.get_all({"parent_id": parent["id"]}))[0]

    # A member task is somebody's copy — re-assigning it would fork the chain.
    resp = await bootstrapped_client.post(
        f"{GRAPH}/task/{child.id}/assign-task", json={"email": "carol@x.com"}
    )
    assert resp.status_code == 400

    resp = await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/assign-task", json={})
    assert resp.status_code == 400


async def test_sync_group_merges_member_owned_fields(bootstrapped_client, hub_faked, monkeypatch):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Audit"})
    group = await _create(
        bootstrapped_client,
        "contacts_group",
        {"type": "contacts_group", "name": "G", "contacts": [{"email": "bob@x.com"}]},
    )
    await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]})
    child = (await Task.get_all({"parent_id": parent["id"]}))[0]

    import flow_sdk.app.actions.group_task_action as gta

    hub_rows = {
        child.id: {
            "id": child.id,
            "status": "done",
            "completed_at": "2026-07-14T10:00:00Z",
            "updated_date": "2999-01-01T00:00:00Z",  # newer than local → stale
        }
    }

    async def fake_hub_get(entity_type, entity_id=None, *a, **k):
        return hub_rows.get(entity_id)

    monkeypatch.setattr(gta, "hub_get", fake_hub_get)
    # The owner-side sync ALSO pulls each child's comments via
    # ``_sync_remote_children`` (a separate ``hub_get``); stub it to no children
    # so this test stays focused on the member-owned field merge.
    import flow_sdk.app.actions.flow_message_action as fma

    async def fake_sync_remote_children(*a, **k):
        return set()

    monkeypatch.setattr(fma, "_sync_remote_children", fake_sync_remote_children)

    resp = await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/sync-group", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["synced"] == 1

    fresh = await Task.get_one({"id": child.id})
    assert fresh.status == "done"
    assert fresh.completed_at is not None
