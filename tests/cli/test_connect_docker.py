"""`flow connect --docker <container>` — the host-side helpers, without a docker daemon.

Pure helpers are checked directly; the two hub calls the host makes to approve the
container's code go through ``httpx.MockTransport``; the docker calls are checked
by their argv (a recording ``subprocess.run``), never by executing docker.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

import pytest

from flow_sdk.cli.auth.device_enroll import write_marker
from flow_sdk.cli.commands import _docker_enroll as de


@pytest.mark.parametrize(
    "given,expected",
    [
        ("http://localhost:8093", "http://host.docker.internal:8093"),
        ("http://127.0.0.1:8000/", "http://host.docker.internal:8000/"),
        ("https://0.0.0.0", "https://host.docker.internal"),
        ("https://hub.flowpad.ai", "https://hub.flowpad.ai"),
        ("https://hub.example:8443/api/v1", "https://hub.example:8443/api/v1"),
    ],
)
def test_loopback_hubs_become_host_docker_internal(given, expected):
    assert de.rewrite_hub_url_for_container(given) == expected


def test_hub_origin_is_the_configured_hub(monkeypatch):
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_base_url", lambda: "http://localhost:8093")
    assert de.hub_origin() == "http://localhost:8093"
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_base_url", lambda: None)
    with pytest.raises(de.DockerEnrollError, match="no hub configured"):
        de.hub_origin()


def test_container_env_has_exactly_what_the_container_needs():
    env = de.container_env("http://localhost:8093")
    assert env.splitlines() == [
        "FLOWPAD_HUB_URL=http://host.docker.internal:8093",
        "PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring",
        "LOCAL_SERVER_PORT=9007",
        "FLOW_INSTANCE=docker",
    ]


def test_detached_command_sources_the_env_and_passes_the_marker_files():
    cmd = de.detached_command("@docker-it's-mine")
    assert cmd.startswith(f"set -a; . {de.ENV_FILE}; set +a; echo $$ > {de.PID_FILE}; exec {de.VENV_FLOW} connect")
    assert f"--code-file {de.CODE_FILE}" in cmd and f"--ready-file {de.READY_FILE}" in cmd
    quoted_name = shlex.quote("@docker-it's-mine")
    assert f"--name {quoted_name}" in cmd  # shell-safe name
    assert cmd.endswith(f"> {de.LOG_FILE} 2>&1")


def test_ghost_kill_script_targets_flow_connect_and_clears_markers():
    script = de.ghost_kill_script()
    assert "flow connect" in script and de.PID_FILE in script
    for marker in (de.CODE_FILE, de.READY_FILE, de.LOG_FILE):
        assert marker in script


def test_marker_round_trip_and_partial_reads(tmp_path):
    path = tmp_path / "m.json"
    assert de.parse_marker("") is None and de.parse_marker('{"user_code": ') is None
    write_marker(path, {"user_code": "WDJB-MJHT", "expires_in": 900})
    assert de.parse_marker(path.read_text()) == {"user_code": "WDJB-MJHT", "expires_in": 900}
    assert not path.with_suffix(".json.tmp").exists()


async def test_host_approves_the_container_code_over_the_shared_hub_client(monkeypatch):
    calls: list[tuple[str, str, dict]] = []

    async def fake_hub_post(entity_type, body, entity_id=None, action=None, **kwargs):
        calls.append((entity_type, action, body))
        if action == "lookup":
            return {"hostname": "box", "os_type": "Linux"}
        return {"node_id": "n-1", "node_name": body["node_name"]}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_hub_post)
    result = await de.approve_container_code("WDJB-MJHT", "@docker-box")

    assert [(t, a) for t, a, _ in calls] == [("machine-enroll", "lookup"), ("machine-enroll", "approve")]
    assert calls[1][2] == {"user_code": "WDJB-MJHT", "node_name": "@docker-box"}
    assert result["node_id"] == "n-1" and result["machine"]["hostname"] == "box"


async def test_a_refused_code_surfaces_the_hubs_reason(monkeypatch):
    from flow_sdk.cloud_client.shared.errors import HubError

    async def fake_hub_post(*_args, **_kwargs):
        raise HubError(404, "No pending enrollment for that code")

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_hub_post)
    with pytest.raises(HubError, match="No pending enrollment"):
        await de.approve_container_code("ZZZZ-ZZZZ", "@docker-box")


def test_docker_calls_use_the_container_and_detach_the_worker(monkeypatch):
    recorded: list[list[str]] = []

    def fake_run(argv, **kwargs):
        recorded.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="true\n", stderr="")

    monkeypatch.setattr(de.subprocess, "run", fake_run)
    dock = de.Docker("/usr/bin/docker", "box")
    dock.ensure_running()
    dock.start_connect("@docker-box")
    dock.read_markers()
    assert recorded[0] == ["/usr/bin/docker", "inspect", "-f", "{{.State.Running}}", "box"]
    assert recorded[1][:5] == ["/usr/bin/docker", "exec", "-d", "box", "bash"] and "flow connect" in recorded[1][-1]
    # One exec reads BOTH markers — the poll loop runs every second.
    assert recorded[2][:5] == ["/usr/bin/docker", "exec", "box", "bash", "-c"]
    assert de.READY_FILE in recorded[2][-1] and de.CODE_FILE in recorded[2][-1]


def test_wheel_and_install_script_are_looked_up_next_to_the_package():
    script = de.find_install_script()
    assert script and Path(script).name == "install_flow_on_docker.sh"
    wheel = de.find_wheel()
    assert wheel is None or Path(wheel).name.startswith("flowpad-")


def test_docker_flag_rejects_the_in_container_marker_options():
    from typer.testing import CliRunner

    from flow_sdk.cli.flow_cli import app

    result = CliRunner().invoke(app, ["connect", "--docker", "box", "--code-file", "/tmp/x"])
    assert result.exit_code == 2
    assert "in-container" in result.output


def test_prepare_writes_env_kills_ghosts_and_probes_the_gateway_in_one_exec(monkeypatch):
    recorded: list[list[str]] = []

    def fake_run(argv, **kwargs):
        recorded.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="HOST_GATEWAY_OK\n", stderr="")

    monkeypatch.setattr(de.subprocess, "run", fake_run)
    dock = de.Docker("/usr/bin/docker", "box")
    assert dock.prepare(de.container_env("http://localhost:8093")) is True

    assert len(recorded) == 1
    script = recorded[0][-1]
    assert de.ENV_FILE in script and "flow connect" in script and "getent hosts host.docker.internal" in script


def test_prepare_reports_a_missing_host_gateway(monkeypatch):
    monkeypatch.setattr(
        de.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
    )
    assert de.Docker("/usr/bin/docker", "box").prepare("FLOWPAD_HUB_URL=x\n") is False
