"""Real wizard process lifecycle tests.

These tests use a real uvicorn server subprocess, a real WebSocket watch, and
the real ``flow wizard`` CLI command. There is no monkeypatching of
``emit_entity_event`` or CLI HTTP plumbing here: the assertion watches the same
``flow_data_msg`` entity-event envelope the frontend consumes.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import uuid

import httpx
import pytest
import websockets

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


def _server_env(port: int, db_path: str, flow_home: str, instance_name: str) -> dict:
    env = os.environ.copy()
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    env["FLOW_INSTANCE"] = instance_name
    env["FLOW_HOME"] = flow_home
    env["SQLITE_DATABASE_PATH"] = db_path
    env["MINIHUB_HOST"] = "127.0.0.1"
    env["LOCAL_SERVER_PORT"] = str(port)
    env["FLOWPAD_SKIP_DOTENV"] = "true"
    env["PYTHONPATH"] = f"{repo_root}{os.pathsep}{env.get('PYTHONPATH', '')}"
    return env


async def _wait_for_server(base_url: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.get(f"{base_url}/health/status")
                if resp.status_code == 200:
                    return
            except httpx.ConnectError:
                pass
            await asyncio.sleep(0.2)
    raise TimeoutError(f"Server at {base_url} did not become ready within {timeout}s")


@pytest.fixture()
async def live_wizard_server(allocate_ports, tmp_path):
    port, = allocate_ports()
    base_url = f"http://127.0.0.1:{port}"
    db_path = str(tmp_path / "flowpad.db")
    flow_home = str(tmp_path / "flow-home")
    instance_name = f"wizard-e2e-{uuid.uuid4().hex[:8]}"
    env = _server_env(port, db_path, flow_home, instance_name)

    proc = subprocess.Popen(
        [sys.executable, "-m", "flow_sdk.server.run"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        await _wait_for_server(base_url)
        yield port, base_url, env
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


async def _create_wizard_process(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/graph/agentic_process",
        json={
            "worker_type": "claude_code",
            "process_type": "wizard",
            "visible": False,
            "pty_mode": False,
            "load_flowpad_assistant": False,
            "context_data": {"wizard": {"name": "git-setup"}},
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


async def _watch_process(client: httpx.AsyncClient, process_id: str, connection_id: str) -> None:
    resp = await client.post(
        f"/api/v1/graph/agentic_process/{process_id}/watch",
        json={"connection_id": connection_id},
    )
    assert resp.status_code == 200, resp.text


async def _recv_wizard_closed(ws, process_id: str) -> dict:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        msg = json.loads(raw)
        if msg.get("message_type") != "flow_data_msg":
            continue
        if msg.get("to_entity") != f"agentic_process-{process_id}":
            continue
        flow_data = msg.get("flow_data") or {}
        attrs = flow_data.get("attributes") or {}
        if attrs.get("event") == "wizard.closed":
            payload = attrs.get("payload")
            assert isinstance(payload, dict)
            return payload
    raise AssertionError("wizard.closed was not delivered over the watched WebSocket")


@pytest.mark.timeout(45)
async def test_flow_wizard_cli_closes_real_process_and_delivers_ws_event(live_wizard_server):
    port, base_url, env = live_wizard_server
    connection_id = f"wizard-test-{uuid.uuid4()}"

    async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as client:
        bootstrap = await client.get("/api/v1/graph/bootstrap")
        assert bootstrap.status_code == 200, bootstrap.text

        ws_url = f"ws://127.0.0.1:{port}/api/v1/connect/ws/{connection_id}"
        async with websockets.connect(ws_url) as ws:
            hello = json.loads(await ws.recv())
            assert hello.get("message_type") == "response_msg"

            process_id = await _create_wizard_process(client)
            await _watch_process(client, process_id, connection_id)

            cli = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "flow_sdk.cli.flow_cli",
                "wizard",
                f"agentic_process-{process_id}",
                "close",
                json.dumps({"status": "done", "data": {"localPath": "/tmp/app"}}),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(cli.communicate(), timeout=15)
            assert cli.returncode == 0, (
                f"flow wizard failed with {cli.returncode}\n"
                f"stdout: {stdout.decode()}\nstderr: {stderr.decode()}"
            )
            cli_payload = json.loads(stdout.decode())
            assert cli_payload["ok"] is True
            assert cli_payload["process_id"] == process_id
            assert cli_payload["result"]["status"] == "done"

            ws_payload = await _recv_wizard_closed(ws, process_id)
            assert ws_payload == {
                "status": "done",
                "data": {"localPath": "/tmp/app"},
                "errorStr": None,
                "wizardId": process_id,
            }
