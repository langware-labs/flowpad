"""API tests for FS open action dispatch."""

import pytest

from flow_sdk.responses.response import ApiResponse
from flow_sdk.storage import StoragePermissionError
from flow_sdk.storage.local_fs_driver import LocalStorageDriver


@pytest.mark.asyncio
async def test_fs_open_dispatches_to_os_handler(bootstrapped_client, monkeypatch):
    """fs/open should invoke desktop OS opener and return success message."""
    calls = []

    def fake_run(cmd, check=True, shell=False):
        calls.append({"cmd": cmd, "check": check, "shell": shell})
        return None

    monkeypatch.setattr("flow_sdk.api.fs.desktop_open.subprocess.run", fake_run)

    response = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/fs/open")
    assert response.status_code == 200, response.text

    parsed = ApiResponse.parse_json(response.text)
    assert parsed.status == "SUCCESS"
    assert isinstance(parsed.data, str)
    assert parsed.data.startswith("Opened")
    assert calls, "Expected subprocess.run to be called by fs/open"


@pytest.mark.asyncio
async def test_fs_browse_permission_denied_returns_403(bootstrapped_client, monkeypatch):
    """fs/browse permission errors should be explicit 403 responses (not generic 500)."""

    async def _deny_list_dir(self, _vfs_path=None):
        raise StoragePermissionError("Permission denied: /home")

    monkeypatch.setattr(LocalStorageDriver, "list_dir", _deny_list_dir)

    response = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/fs/browse/home")
    assert response.status_code == 403, response.text

    parsed = ApiResponse.parse_json(response.text)
    assert parsed.status == "FAIL"
    assert isinstance(parsed.message, str)
    assert "not allowed" in parsed.message.lower()
    assert "/home" in parsed.message
