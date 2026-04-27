"""API tests for ClaudeHookRecord through the fs-records endpoint."""

import json
from pathlib import Path
from unittest import mock

import pytest

from flow_sdk.fs_store import set_default_records_root, get_default_records_root

# Import to trigger auto-registration
from flow_sdk.fs_records.claude.claude_hook_record import (  # noqa: F401
    ClaudeHookRecord,
    ClaudeHookRecordList,
)


SAMPLE_HOOKS = {
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {"type": "command", "command": "echo pre-bash"},
                    {"type": "command", "command": "echo second"},
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {"type": "command", "command": "echo post-all"},
                ],
            },
        ],
    },
}


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.fixture
def hooks_dir(tmp_path):
    """Create a temp directory with a settings.json containing hooks."""
    settings_dir = tmp_path / "hooks_settings"
    settings_dir.mkdir()
    f = settings_dir / "settings.json"
    f.write_text(json.dumps(SAMPLE_HOOKS))
    return settings_dir


@pytest.fixture(autouse=True)
def patch_discover(hooks_dir):
    """Patch ClaudeHookRecord.discover and get to use temp settings files."""
    original_discover = ClaudeHookRecord.discover.__func__
    original_get = ClaudeHookRecord.get.__func__

    @classmethod
    def patched_discover(cls, scope=None, **kwargs):
        kwargs.setdefault("search_paths", [hooks_dir])
        return original_discover(cls, scope=scope, **kwargs)

    @classmethod
    def patched_get(cls, uid, scope=None, **kwargs):
        kwargs.setdefault("search_paths", [hooks_dir])
        return original_get(cls, uid, scope=scope, **kwargs)

    with mock.patch.object(ClaudeHookRecord, "discover", patched_discover):
        with mock.patch.object(ClaudeHookRecord, "get", patched_get):
            yield


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_type_listed(bootstrapped_client):
    """claude_hook should appear in the registered types list."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert "claude_hook" in body["data"]["types"]


@pytest.mark.asyncio
async def test_list_hooks(bootstrapped_client):
    """GET /fs-records/claude_hook should return all discovered hooks."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    records = body["data"]
    assert len(records) == 3  # 2 PreToolUse + 1 PostToolUse

    # Verify fields present
    first = records[0]
    assert "event_type" in first
    assert "matcher" in first
    assert "command" in first


@pytest.mark.asyncio
async def test_get_one_hook(bootstrapped_client):
    """GET /fs-records/claude_hook/{uid} should return a specific hook."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    # List first to get a uid
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook"
    )
    records = resp.json()["data"]
    uid = records[0]["id"]

    # Get one
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook/{uid}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["id"] == uid
    assert "event_type" in body["data"]


@pytest.mark.asyncio
async def test_get_nonexistent_returns_404(bootstrapped_client):
    """GET with a bad uid should return 404."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook/nonexistent-uid"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_hook(bootstrapped_client, hooks_dir):
    """PUT /fs-records/claude_hook/{uid} should update the command."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    # List to get a uid
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook"
    )
    records = resp.json()["data"]
    uid = records[0]["id"]

    # Update
    resp = await bootstrapped_client.put(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook/{uid}",
        json={"command": "echo updated-cmd"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["command"] == "echo updated-cmd"

    # Verify the file was updated
    settings_file = hooks_dir / "settings.json"
    raw = json.loads(settings_file.read_text())
    first_hook = raw["hooks"]["PreToolUse"][0]["hooks"][0]
    assert first_hook["command"] == "echo updated-cmd"


@pytest.mark.asyncio
async def test_delete_hook(bootstrapped_client, hooks_dir):
    """DELETE /fs-records/claude_hook/{uid} should remove the hook."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    # List to get a uid
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook"
    )
    records = resp.json()["data"]
    uid = records[0]["id"]

    # Delete
    resp = await bootstrapped_client.request(
        "DELETE",
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook/{uid}",
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] == uid

    # Re-GET should 404
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_hook/{uid}"
    )
    assert resp.status_code == 404
