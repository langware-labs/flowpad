"""ComputeNode HTTP-action sweep — Desktop / Analytics / ops / worker-history.

Drives the documented `/api/v1/graph/compute_node/{id}/{action}` interface via
`bootstrapped_client`. Covers the Desktop mixin (get-host redirect,
machine-status, system-profile, get/save-json-file round-trip, guarded
pick-folder / open-terminal / open-external, generate-amd-plan), the Analytics
mixin (get-cost-overview, get-claude-context), the unified worker-history
action (limit + project_ids scoping), and `ops/command` (buffered + streaming)
against a cheap real command.

No mocks on the entity/HTTP path. Two OS boundaries are stubbed so the test
never actually opens a GUI app or spends model tokens: `subprocess.Popen`
(native terminal), the provider's native `pick_folder` dialog, and the
`claude -p /context` CLI probe — the same boundary-stub approach the existing
`tests/api/test_compute_api.py` uses for `subprocess.Popen`.
"""

import shlex
import sys

import pytest

import flow_sdk.builtin.faas.analytics.claude_context as claude_context_mod
from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider
from tests.api.conftest import default_compute_node_id


def _py(script: str) -> str:
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(script)}"


# ---------------------------------------------------------------------------
# Desktop mixin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_host_redirects_to_localhost_port(bootstrapped_client, bootstrap_payload):
    """get-host with a provider set returns a redirect to http://localhost:<port>."""
    node_id = default_compute_node_id(bootstrap_payload)

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/get-host?port=8080",
        follow_redirects=False,
    )
    assert resp.status_code in (302, 307), resp.text
    assert resp.headers["location"] == "http://localhost:8080"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_host_rejects_out_of_range_port(bootstrapped_client, bootstrap_payload):
    """A port outside 1024-65535 is a guarded failure, not a redirect."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/get-host?port=80",
        follow_redirects=False,
    )
    assert resp.json()["status"] == "FAIL", resp.text


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_machine_status_envelope(bootstrapped_client, bootstrap_payload):
    """get-machine-status returns a MachineStatus-shaped payload."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{node_id}/get-machine-status")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    data = payload["data"]
    # Documented MachineStatus shape: processes + network snapshot.
    assert "processes" in data
    assert "network" in data
    assert isinstance(data["processes"], list)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_system_profile_envelope(bootstrapped_client, bootstrap_payload):
    """get-system-profile returns a SystemProfile with machine + generated set."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{node_id}/get-system-profile")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    assert "generated" in payload["data"]
    assert "machine" in payload["data"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_json_file_round_trip(bootstrapped_client, bootstrap_payload, tmp_path):
    """save-json-file then get-json-file returns the same object."""
    node_id = default_compute_node_id(bootstrap_payload)
    target = str(tmp_path / "round_trip.json")
    body = {"path": target, "data": {"alpha": 1, "beta": ["x", "y"]}}

    save = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/save-json-file", json=body
    )
    assert save.status_code == 200, save.text
    assert save.json()["status"] == "SUCCESS"

    read = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/get-json-file?path={target}"
    )
    assert read.status_code == 200, read.text
    read_payload = read.json()
    assert read_payload["status"] == "SUCCESS"
    assert read_payload["data"] == {"alpha": 1, "beta": ["x", "y"]}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_json_file_missing_path_param(bootstrapped_client, bootstrap_payload):
    """get-json-file without a path param is a guarded failure."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{node_id}/get-json-file")
    assert resp.json()["status"] == "FAIL", resp.text


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_pick_folder_route_guarded(bootstrapped_client, bootstrap_payload, monkeypatch):
    """pick-folder is wired and returns {path: ...} without opening a real dialog.

    The native OS dialog is stubbed (simulating a cancel) so the test never
    blocks on a GUI; the action's envelope wiring is still exercised for real.
    """
    async def _fake_pick_folder(self, provider_node_id, initial_dir=None, mode="folder"):
        return None

    monkeypatch.setattr(LocalComputeProvider, "pick_folder", _fake_pick_folder)

    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/pick-folder", json={}
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    assert payload["data"] == {"path": None}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_open_terminal_route_guarded(bootstrapped_client, bootstrap_payload, monkeypatch):
    """open-terminal is wired; the spawn is captured so no real terminal opens."""
    captured = {}

    def _fake_popen(cmd, *args, **kwargs):
        captured["cmd"] = cmd

        class _P:
            returncode = 0

        return _P()

    monkeypatch.setattr("subprocess.Popen", _fake_popen)
    # Linux probes shutil.which for an emulator BEFORE Popen; headless CI has
    # none, so stub discovery too — the spawn itself is already captured above.
    monkeypatch.setattr("shutil.which", lambda _name: "/usr/bin/fake-terminal")

    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/open-terminal",
        json={"command": "echo hi"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "SUCCESS"
    assert "cmd" in captured  # a spawn was attempted, but stubbed


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_open_terminal_requires_command(bootstrapped_client, bootstrap_payload):
    """open-terminal without a command is a guarded failure (no spawn)."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/open-terminal", json={}
    )
    assert resp.json()["status"] == "FAIL", resp.text


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_open_external_missing_path_guarded(bootstrapped_client, bootstrap_payload):
    """open-external on a non-existent path fails cleanly without opening anything."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/open-external",
        json={"path": "/no/such/path/nowhere-xyz-123"},
    )
    assert resp.json()["status"] == "FAIL", resp.text


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_generate_amd_plan_envelope(bootstrapped_client, bootstrap_payload):
    """generate-amd-plan is wired and returns an envelope (desktop stub → FAIL)."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/generate-amd-plan",
        json={"content": "build me a todo app"},
    )
    payload = resp.json()
    # Desktop mode has no AMD generator; the documented behavior is a clean FAIL.
    assert payload["status"] == "FAIL", resp.text
    assert "desktop" in payload["message"].lower()


# ---------------------------------------------------------------------------
# Analytics mixin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_cost_overview_shape(bootstrapped_client, bootstrap_payload):
    """get-cost-overview returns the documented overview shape."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/get-cost-overview?limit=5"
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    data = payload["data"]
    for key in ("session_count", "totals", "by_day", "by_model", "by_project", "top_sessions_by_cost"):
        assert key in data, f"missing cost-overview key: {key}"
    assert "total_cost_usd" in data["totals"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_get_claude_context_envelope(bootstrapped_client, bootstrap_payload, monkeypatch):
    """get-claude-context wraps the /context probe result in the envelope.

    The `claude -p /context` CLI subprocess is stubbed so the test is
    deterministic and spends no tokens; the action's param plumbing + envelope
    wrapping run for real.
    """
    def _fake_context(session_id=None, session_title=None):
        return {"model": "claude-x", "tokens_used": 123, "session_id": session_id}

    # The action imports get_claude_context_sync from this module at call time,
    # so patch it at the source (not on the actions module).
    monkeypatch.setattr(claude_context_mod, "get_claude_context_sync", _fake_context)

    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/get-claude-context"
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    assert isinstance(payload["data"], dict)
    assert payload["data"]["model"] == "claude-x"


# ---------------------------------------------------------------------------
# worker-history
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_history_limit(bootstrapped_client, bootstrap_payload):
    """worker-history applies limit as a per-project cap, not a global top-N.

    Each project_id bucket keeps at most ``limit`` rows (the documented
    per-scope semantics), so the total can exceed ``limit`` across buckets but
    no single bucket may.
    """
    limit = 2
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/worker-history?limit={limit}"
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    assert isinstance(payload["data"], list)

    from collections import Counter

    buckets = Counter(entry.get("project_id") for entry in payload["data"])
    assert all(count <= limit for count in buckets.values()), buckets


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_worker_history_project_scoped(bootstrapped_client, bootstrap_payload):
    """worker-history with a project_ids scope returns a (possibly empty) list.

    A project id with no sessions yields an empty scoped list — the per-project
    branch is exercised without depending on machine session history.
    """
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{node_id}/worker-history"
        "?limit=5&project_ids=project-does-not-exist-xyz"
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    assert payload["data"] == []


# ---------------------------------------------------------------------------
# ops/command
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_ops_command_buffered(bootstrapped_client, bootstrap_payload):
    """ops/command (stream=false) runs a real command and returns stdout + exit-code."""
    node_id = default_compute_node_id(bootstrap_payload)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/ops/command",
        json={"command": _py("print('ops-buffered-marker')"), "stream": False},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "SUCCESS"
    xml = payload["data"]
    assert "ops-buffered-marker" in xml
    assert 'exit-code="0"' in xml


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_ops_command_missing_command_guarded(bootstrapped_client, bootstrap_payload):
    """ops/command with no command is a guarded failure."""
    node_id = default_compute_node_id(bootstrap_payload)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/ops/command",
        json={"stream": False},
    )
    assert resp.json()["status"] == "FAIL"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_ops_command_streaming(bootstrapped_client, bootstrap_payload):
    """ops/command (stream=true) streams stdout chunks and a final exit-code chunk."""
    node_id = default_compute_node_id(bootstrap_payload)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/ops/command",
        json={"command": _py("print('ops-stream-marker')"), "stream": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    text = resp.text
    assert "ops-stream-marker" in text
    assert 'exit-code="0"' in text
