"""Tests for compute node API endpoints and functionality."""

import os
from pathlib import Path

import pytest

import flow_sdk.builtin.faas.compute_node as compute_node_module


def _capture_open_calls(monkeypatch: pytest.MonkeyPatch) -> dict:
    calls: dict = {}

    def fake_popen(cmd, *args, **kwargs):
        calls["popen"] = cmd

        class _DummyProcess:
            returncode = 0

        return _DummyProcess()

    monkeypatch.setattr("subprocess.Popen", fake_popen)

    if hasattr(os, "startfile"):
        monkeypatch.setattr(os, "startfile", lambda path: calls.__setitem__("startfile", path))

    return calls


def _get_default_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_open_external_resolves_workspace_relative_path(bootstrapped_client, monkeypatch, tmp_path: Path):
    """Relative paths should resolve against AGENT_MOUNT_FOLDER workspace."""
    workspace = tmp_path / "Flowpad workspace"
    project_dir = workspace / "my_first_project"
    project_dir.mkdir(parents=True)

    monkeypatch.setattr(compute_node_module, "AGENT_MOUNT_FOLDER", str(workspace))
    open_calls = _capture_open_calls(monkeypatch)

    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/open-external",
        json={"path": "my_first_project"},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "SUCCESS"
    assert payload["data"]["opened"] == str(project_dir)

    if "popen" in open_calls:
        assert str(project_dir) in open_calls["popen"]
    else:
        assert open_calls.get("startfile") == str(project_dir)


@pytest.mark.asyncio
async def test_open_external_keeps_absolute_path(bootstrapped_client, monkeypatch, tmp_path: Path):
    """Absolute paths should be opened as-is."""
    absolute_target = tmp_path / "absolute-target"
    absolute_target.mkdir(parents=True)

    open_calls = _capture_open_calls(monkeypatch)

    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/open-external",
        json={"path": str(absolute_target)},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == "SUCCESS"
    assert payload["data"]["opened"] == str(absolute_target)

    if "popen" in open_calls:
        assert str(absolute_target) in open_calls["popen"]
    else:
        assert open_calls.get("startfile") == str(absolute_target)
