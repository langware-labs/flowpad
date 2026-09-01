"""The ``flow connect`` worker against a stand-in hub.

A tiny WebSocket server plays the hub's ``/compute-node/{id}/ws`` route: it reads
the worker's hello, answers ``ws_ready_msg`` and then issues the same
``rest_api_msg`` frames the hub's ``UserMachineComputeProvider`` sends. The real
worker executes them on this machine.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import uuid

import pytest
import websockets

from flow_sdk.compute.user_machine.worker import UserMachineWorker, build_hub_node_ws_url


class FakeHub:
    """One accepted worker socket + helpers to talk to it like the hub does."""

    def __init__(self) -> None:
        self.hello: dict | None = None
        self.ws = None
        self.attached = asyncio.Event()
        self._pending: dict[str, asyncio.Future] = {}
        self.cmd_frames: dict[str, list[dict]] = {}
        self.pty_frames: dict[str, list[bytes]] = {}
        self.server = None
        self.port = 0

    async def start(self) -> None:
        self.server = await websockets.serve(self._handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    async def _handler(self, ws) -> None:
        self.hello = json.loads(await ws.recv())
        self.ws = ws
        await ws.send(json.dumps({"message_type": "ws_ready_msg"}))
        self.attached.set()
        try:
            async for raw in ws:
                frame = json.loads(raw)
                kind = frame.get("message_type")
                if kind == "response_msg":
                    fut = self._pending.pop(frame.get("response_message_id"), None)
                    if fut and not fut.done():
                        if frame.get("error"):
                            fut.set_exception(RuntimeError(frame["error"]))
                        else:
                            fut.set_result(frame.get("content"))
                elif kind == "cmd_status_msg":
                    self.cmd_frames.setdefault(frame["command_message_id"], []).append(frame)
                elif kind == "pty_output_msg":
                    self.pty_frames.setdefault(frame["session_id"], []).append(base64.b64decode(frame["data"]))
        except websockets.ConnectionClosed:
            pass

    async def request(self, sub_path: str, body: dict | None = None, timeout: float = 10.0):
        request_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        await self.ws.send(
            json.dumps(
                {
                    "message_type": "rest_api_msg",
                    "message_id": request_id,
                    "action": "compute-node",
                    "sub_path": sub_path,
                    "body": body or {},
                }
            )
        )
        return await asyncio.wait_for(fut, timeout=timeout)

    async def wait_exit(self, command_message_id: str, timeout: float = 10.0) -> tuple[int, str, str]:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            frames = self.cmd_frames.get(command_message_id, [])
            done = [f for f in frames if f.get("exit_code") is not None]
            if done:
                stdout = "".join(f.get("stdout") or "" for f in frames)
                stderr = "".join(f.get("stderr") or "" for f in frames)
                return int(done[0]["exit_code"]), stdout, stderr
            await asyncio.sleep(0.02)
        raise AssertionError(f"command {command_message_id} did not finish")


async def _connected_worker(tmp_path):
    hub = FakeHub()
    await hub.start()
    worker = UserMachineWorker(
        node_id="node-1",
        machine_id="machine-1",
        ws_url=build_hub_node_ws_url(f"http://127.0.0.1:{hub.port}/api/v1", "node-1"),
        headers={"Authorization": "Bearer test"},
        home_dir=str(tmp_path),
    )
    task = asyncio.create_task(worker.run_forever())
    await asyncio.wait_for(hub.attached.wait(), timeout=10)
    return hub, worker, task


async def _stop(hub, worker, task):
    worker.stop_event.set()
    await asyncio.wait_for(task, timeout=10)
    await hub.stop()


def test_ws_url_is_derived_from_the_api_base_url():
    assert build_hub_node_ws_url("https://hub.example/api/v1", "n1") == "wss://hub.example/api/v1/compute-node/n1/ws"
    assert (
        build_hub_node_ws_url("http://localhost:8093/api/v1/", "n1") == "ws://localhost:8093/api/v1/compute-node/n1/ws"
    )


async def test_worker_honors_standard_proxy_discovery(monkeypatch, tmp_path):
    """Restricted sandboxes reach the Hub command channel via HTTPS_PROXY."""
    captured = {}

    class StopAfterConnect:
        async def __aenter__(self):
            captured["entered"] = True
            raise asyncio.CancelledError

        async def __aexit__(self, *args):
            return False

    def fake_connect(*args, **kwargs):
        captured.update(kwargs)
        return StopAfterConnect()

    monkeypatch.setattr(websockets, "connect", fake_connect)
    worker = UserMachineWorker(
        node_id="node-1",
        machine_id="machine-1",
        ws_url="wss://hub.example/api/v1/compute-node/node-1/ws",
        headers={"Authorization": "Bearer test"},
        home_dir=str(tmp_path),
    )

    with pytest.raises(asyncio.CancelledError):
        await worker.run_forever()

    assert captured["entered"] is True
    assert captured["proxy"] is True


async def test_hello_describes_this_machine_and_names_the_node(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        assert hub.hello["message_type"] == "client_node_ready_msg"
        assert hub.hello["node_id"] == "node-1"
        assert hub.hello["machine_id"] == "machine-1"
        assert hub.hello["home_path"] == str(tmp_path)
        assert hub.hello["cpu_count"] >= 1
    finally:
        await _stop(hub, worker, task)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell semantics")
async def test_run_streams_output_and_exit_code_from_the_home_dir(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        cmd_id = uuid.uuid4().hex
        ack = await hub.request("run", {"command_message_id": cmd_id, "cmd": "pwd; echo err >&2; exit 3", "env": {}})
        assert ack["started"] is True
        exit_code, stdout, stderr = await hub.wait_exit(cmd_id)
        assert exit_code == 3
        assert stdout.strip() == str(tmp_path.resolve()) or stdout.strip() == str(tmp_path)
        assert stderr.strip() == "err"

        cmd_id = uuid.uuid4().hex
        await hub.request("run", {"command_message_id": cmd_id, "cmd": "echo $FOO", "env": {"FOO": "bar"}})
        assert (await hub.wait_exit(cmd_id))[1].strip() == "bar"
    finally:
        await _stop(hub, worker, task)


async def test_files_round_trip_on_the_real_filesystem(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        target = str(tmp_path / "sub" / "x.txt")
        assert (await hub.request("exists", {"paths": [target]}))[target] is False
        payload = base64.b64encode(b"hello").decode()
        assert await hub.request("write_files", {"files": [{"path": target, "data": payload}]}) == [target]
        assert (tmp_path / "sub" / "x.txt").read_bytes() == b"hello"
        assert (await hub.request("exists", {"paths": [target]}))[target] is True
        read = await hub.request("read_files", {"paths": [target]})
        assert base64.b64decode(read[target]) == b"hello"
        listing = await hub.request("list_dir", {"paths": [str(tmp_path / "sub")]})
        assert listing[str(tmp_path / "sub")] == [{"name": "x.txt", "remote_path": target, "is_dir": False}]
        await hub.request("create_folders", {"paths": [str(tmp_path / "d1" / "d2")]})
        assert (tmp_path / "d1" / "d2").is_dir()
        await hub.request("delete_files", {"paths": [target, str(tmp_path / "d1")]})
        assert not (tmp_path / "sub" / "x.txt").exists() and not (tmp_path / "d1").exists()
        with pytest.raises(RuntimeError):
            await hub.request("read_files", {"paths": [str(tmp_path / "missing")]})
    finally:
        await _stop(hub, worker, task)


async def test_unknown_requests_are_refused_not_ignored(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="unsupported sub_path"):
            await hub.request("format_disk", {})
    finally:
        await _stop(hub, worker, task)


@pytest.mark.skipif(sys.platform == "win32", reason="PTY is POSIX-only")
async def test_pty_output_streams_back_and_input_is_delivered(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        started = await hub.request("pty_start", {"session_id": "s1", "rows": 24, "cols": 80})
        assert started["pid"]
        marker = f"marker-{uuid.uuid4().hex[:6]}"
        await hub.request(
            "pty_input",
            {
                "session_id": "s1",
                "data": base64.b64encode(f"echo {marker}\n".encode()).decode(),
                "cols": 80,
                "rows": 24,
            },
        )
        deadline = asyncio.get_running_loop().time() + 10
        while asyncio.get_running_loop().time() < deadline:
            if marker.encode() in b"".join(hub.pty_frames.get("s1", [])):
                break
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("pty output never echoed the marker")
        await hub.request("pty_resize", {"session_id": "s1", "cols": 100, "rows": 30})
        await hub.request("pty_close", {"session_id": "s1"})
    finally:
        await _stop(hub, worker, task)


async def test_shutdown_request_stops_the_worker(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        assert await hub.request("shutdown", {}) == {"stopping": True}
        await asyncio.wait_for(task, timeout=10)
        assert worker.stop_event.is_set()
    finally:
        await hub.stop()


@pytest.mark.long  # 1.04s
async def test_worker_reconnects_after_the_hub_drops_it(tmp_path):
    hub, worker, task = await _connected_worker(tmp_path)
    try:
        hub.attached.clear()
        await hub.ws.close()
        await asyncio.wait_for(hub.attached.wait(), timeout=10)
        assert hub.hello["node_id"] == "node-1"
        cmd_id = uuid.uuid4().hex
        await hub.request("run", {"command_message_id": cmd_id, "cmd": "echo back", "env": {}})
        assert (await hub.wait_exit(cmd_id))[1].strip() == "back"
    finally:
        await _stop(hub, worker, task)


def test_command_env_puts_flow_on_path():
    from flow_sdk.compute.user_machine.worker import _command_env

    env = _command_env({"X": "1"})
    assert env["X"] == "1"
    assert env["PATH"].split(os.pathsep)[-1] == os.environ.get("PATH", "").split(os.pathsep)[-1]
