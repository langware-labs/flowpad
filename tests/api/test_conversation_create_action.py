"""Tests for the project-scoped conversation create action.

POST /api/v1/graph/conversation-create  — create Conversation under a Project
with a participants list. Each participant email is upserted as a User so the
contact list grows.

Conversations are standard records: their data file lives at the canonical
records-data location `<records_data_root>/conversation/conversation-@<id>/conversation.jsonl`,
NOT inside the project's filesystem mount. These tests pin that contract.
"""

from pathlib import Path

import pytest

from flow_sdk.fs_store.operations.conversation import default_data_dir, default_jsonl_path, from_jsonl
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record_paths import get_default_records_data_root, record_stem

# ---------------------------------------------------------------------------
# Existing happy paths — updated to the new on-disk contract.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_under_project_upserts_participants(bootstrapped_client):
    """Create + verify participants land as Users + jsonl file at standard path."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local_project = next(p for p in projects if p.get("uname") == "local")
    project_id = local_project["id"]

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={
            "project_id": project_id,
            "participants": [
                {"email": "alice@example.com", "name": "Alice"},
                {"email": "bob@example.com"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    data = body["data"]
    assert data["project_id"] == project_id
    conv_id = data["conversation_id"]
    assert conv_id

    # Participants are stored exactly as the caller provided them. The address
    # book may learn contacts, but it must not rewrite Conversation.participants.
    parts = data["participants"]
    assert parts == [
        {"email": "alice@example.com", "name": "Alice"},
        {"email": "bob@example.com"},
    ]

    # The conversation row exists, has project_id, no task_id.
    conv_resp = await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")
    assert conv_resp.status_code == 200, conv_resp.text
    conv = conv_resp.json()["data"]
    assert conv["project_id"] == project_id
    assert not conv.get("task_id")
    assert len(conv["participants"]) == 2

    # Standard records-data location. ``data_path`` is now a derived
    # @property on ``Conversation`` (not a stored field), so it isn't part
    # of the API payload — we just verify the canonical path exists on disk.
    expected_jsonl = default_jsonl_path(conv_id)
    assert expected_jsonl.exists(), f"expected {expected_jsonl} to exist"

    # Both emails are now Users in the contact list.
    users = (await bootstrapped_client.get("/api/v1/graph/user")).json()["data"]
    emails = {u.get("email") for u in users}
    assert "alice@example.com" in emails
    assert "bob@example.com" in emails


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_rejects_missing_project_id(bootstrapped_client):
    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"participants": [{"email": "x@y.com"}]},
    )
    assert response.status_code != 200 or response.json()["status"] != "SUCCESS"
    assert "project_id" in response.text.lower()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_create_with_no_participants(bootstrapped_client):
    """Creating a conversation with no participants is allowed (empty contact list)."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    response = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["participants"] == []


# ---------------------------------------------------------------------------
# New positive cases — pin the standard-records-data behavior.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_jsonl_lands_in_records_data_root(bootstrapped_client):
    """The on-disk jsonl is rooted at `<records_data_root>/conversation/`."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]

    expected_dir = (
        get_default_records_data_root()
        / RecordType.CONVERSATION
        / record_stem(RecordType.CONVERSATION, conv_id)
    )
    expected_jsonl = expected_dir / "conversation.jsonl"
    assert expected_jsonl.exists()
    # Spot the parent layout — `<root>/conversation/conversation-@<id>/`.
    assert expected_dir.parent.name == RecordType.CONVERSATION
    assert expected_dir.name == f"{RecordType.CONVERSATION}-@{conv_id}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_append_conversation_writes_into_records_data_jsonl(bootstrapped_client):
    """`conversation/<id>/add_message` lands the pointer in the records-data file."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    create = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = create.json()["data"]["conversation_id"]

    append = await bootstrapped_client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "hello world"},
    )
    assert append.status_code == 200, append.text
    assert append.json()["status"] == "SUCCESS"

    # The pointer line lands in the records-data-rooted jsonl.
    jsonl_path = default_jsonl_path(conv_id)
    assert jsonl_path.exists()
    contents = jsonl_path.read_text(encoding="utf-8")
    assert append.json()["data"]["flow_message_id"] in contents

    conv = (await bootstrapped_client.get(f"/api/v1/graph/conversation/{conv_id}")).json()["data"]
    assert conv["message_count"] == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_two_creates_yield_two_distinct_records_data_dirs(bootstrapped_client):
    """Each Conversation gets its own `conversation-@<id>/` directory."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    ids: list[str] = []
    for _ in range(2):
        resp = await bootstrapped_client.post(
            "/api/v1/graph/conversation-create",
            json={"project_id": project_id, "participants": []},
        )
        ids.append(resp.json()["data"]["conversation_id"])

    a, b = (default_data_dir(i) for i in ids)
    assert a != b
    assert a.exists() and b.exists()
    assert a.parent == b.parent  # both under <root>/conversation/


# ---------------------------------------------------------------------------
# Negative — regression bars for the bugs that motivated this change.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_jsonl_path_not_under_project_mount(bootstrapped_client):
    """Conversation jsonl is NEVER inside the project's filesystem mount."""
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local = next(p for p in projects if p.get("uname") == "local")
    project_id = local["id"]
    mount_path = Path(local["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]
    jsonl = default_jsonl_path(conv_id).resolve()

    assert mount_path not in jsonl.parents, (
        f"jsonl {jsonl} unexpectedly lives under project mount {mount_path}"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_no_conversations_dir_created_under_project_mount(bootstrapped_client):
    """We don't create the legacy `<project_mount>/conversations/<slug>-<id8>/` tree at all.

    This guards against any leftover code path that re-introduces the
    project-mount layout.
    """
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    local = next(p for p in projects if p.get("uname") == "local")
    project_id = local["id"]
    mount_path = Path(local["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    conv_id = resp.json()["data"]["conversation_id"]

    legacy_root = mount_path / "conversations"
    if legacy_root.exists():
        # The directory may pre-exist from earlier-feature data; what matters is
        # that THIS conversation didn't write there.
        assert not list(legacy_root.glob(f"*-{conv_id[:8]}/conversation.jsonl")), (
            f"Found a legacy-layout dir for conv {conv_id} at {legacy_root}"
        )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_create_under_system_project_does_not_touch_sdk_tree(bootstrapped_client):
    """The flowpad_assistant project's mount is the SDK source tree.

    Old handler joined paths from `fs_storage_mount_path` and would have
    written user data into `flow_sdk/system_projects/flowpad_assistant/`.
    The new handler must not — verify we land in records_data instead.
    """
    projects = (
        await bootstrapped_client.get("/api/v1/graph/project?include_system=true")
    ).json()["data"]
    assistant = next((p for p in projects if p.get("uname") == "flowpad_assistant"), None)
    if not assistant:
        pytest.skip("Flowpad Assistant system project not registered on this instance.")

    project_id = assistant["id"]
    mount_path = Path(assistant["fs_storage_mount_path"]).resolve()

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert resp.status_code == 200, resp.text
    conv_id = resp.json()["data"]["conversation_id"]

    jsonl = default_jsonl_path(conv_id).resolve()
    assert mount_path not in jsonl.parents
    assert "system_projects" not in jsonl.parts


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_directory_uses_canonical_record_stem_not_slug(bootstrapped_client):
    """The created folder uses the standard `conversation-@<id>` stem.

    Earlier the handler built a slug from participant emails, leaking
    addresses into filesystem paths. Verify the stem is canonical.
    """
    projects = (await bootstrapped_client.get("/api/v1/graph/project")).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]

    resp = await bootstrapped_client.post(
        "/api/v1/graph/conversation-create",
        json={
            "project_id": project_id,
            "participants": [{"email": "leak-check@example.com"}],
        },
    )
    conv_id = resp.json()["data"]["conversation_id"]

    parent_dir = default_jsonl_path(conv_id).parent
    assert parent_dir.name == f"{RecordType.CONVERSATION}-@{conv_id}"
    assert "leak-check" not in parent_dir.name
    assert "@" not in parent_dir.name.replace("-@", "")  # only the canonical separator
