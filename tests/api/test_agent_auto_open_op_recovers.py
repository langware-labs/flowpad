"""An ``auto_open`` op recovers a dead server: navigate fails → a rung brings the server
up → the op navigates again → it opens.

Through the real Use route, with no stand-ins: the place is a real port nobody listens
on, the repair rung is a real command that starts a real HTTP server there, and the
verdict is the real probe. (In production the rung is an agent — Spora's assistant;
a cli rung exercises the same ladder without a harness.)
"""
from __future__ import annotations

import json
import os
import signal
import socket
import sys

import pytest

from flow_sdk.core.navigate import pointer_for_web_url
from flow_sdk.request_context.detached import _DETACHED
from flow_sdk.responses.response import ApiResponse
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(sys.platform == "win32", reason="the repair rung is a POSIX command"),
]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _data(resp):
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


def _write_op(root, name: str, url: str, repair: str | None) -> None:
    folder = root / "agentic-assets" / "compute_op" / name
    folder.mkdir(parents=True)
    op = {
        "name": name,
        "subkind": "navigate",
        "exe_data": {"target": {"viewType": "web-app", "pointer": pointer_for_web_url(url)}},
        "attempts": [{"subkind": "cli", "exe_data": {"commands": {sys.platform: repair}}}] if repair else [],
    }
    (folder / "compute_op.json").write_text(json.dumps(op))


async def _session_results(client, process_id: str) -> list[dict]:
    task = next(t for t in list(_DETACHED) if t.get_name() == f"auto_open:{process_id}")
    await task
    process = await _data(await client.get(f"/api/v1/graph/agentic_process/{process_id}"))
    return process["context_data"]["auto_open_results"]


async def test_a_dead_server_is_started_by_the_op_and_opened(bootstrapped_client, tmp_path):
    port = _free_port()
    url = f"http://127.0.0.1:{port}/"
    pidfile = tmp_path / "server.pid"
    serve = tmp_path / "serve.py"
    # Binds BEFORE it detaches: when the command returns, the port is already listening.
    serve.write_text(
        "import http.server, os\n"
        f"server = http.server.ThreadingHTTPServer(('127.0.0.1', {port}), http.server.SimpleHTTPRequestHandler)\n"
        "pid = os.fork()\n"
        f"if pid:\n    open({str(pidfile)!r}, 'w').write(str(pid))\n    os._exit(0)\n"
        # Off the rung's pipes, or the command is not over until the server is.
        "os.setsid()\nnull = os.open(os.devnull, os.O_RDWR)\n"
        "for fd in (0, 1, 2):\n    os.dup2(null, fd)\n"
        "server.serve_forever()\n"
    )
    repair = f"{sys.executable} {serve}"
    root = tmp_path / "proj"
    project = await seed_project(root)
    _write_op(root, "open-admin", url, repair)
    agent = await seed_agent(root, "assistant", auto_open=[{"op": "open-admin"}])
    try:
        used = await _data(
            await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/use", json={"project_id": project.id})
        )
        # The landing did not wait: the place is the display already, server or not.
        process = await _data(await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{used['process_id']}"))
        assert process["context_data"]["last_shown"]["pointer"] == pointer_for_web_url(url)

        [result] = await _session_results(bootstrapped_client, used["process_id"])
        assert result["entry"] == "op:open-admin"
        assert result["exit_code"] == ExitCode.OK and result["verdict"] == "ok", result
        assert "after the cli attempt" in result["detail"]
    finally:
        if pidfile.exists():
            os.kill(int(pidfile.read_text().strip()), signal.SIGTERM)


async def test_with_no_repair_the_dead_server_is_on_record(bootstrapped_client, tmp_path):
    url = f"http://127.0.0.1:{_free_port()}/"
    root = tmp_path / "proj"
    project = await seed_project(root)
    _write_op(root, "open-admin", url, repair=None)
    agent = await seed_agent(root, "assistant", auto_open=[{"op": "open-admin"}, {"op": "no-such-op"}])

    used = await _data(
        await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/use", json={"project_id": project.id})
    )
    results = {r["entry"]: r for r in await _session_results(bootstrapped_client, used["process_id"])}

    assert results["op:open-admin"]["exit_code"] == ExitCode.NOT_YET
    assert results["op:open-admin"]["verdict"] == "not_running"
    assert results["op:no-such-op"]["exit_code"] == ExitCode.NOT_FOUND


async def test_an_op_from_another_project_is_not_run(bootstrapped_client, tmp_path):
    other = tmp_path / "vendor"
    await seed_project(other)
    _write_op(other, "open-admin", f"http://127.0.0.1:{_free_port()}/", repair=None)
    root = tmp_path / "proj"
    project = await seed_project(root)
    agent = await seed_agent(root, "assistant", auto_open=[{"op": "open-admin"}])

    used = await _data(
        await bootstrapped_client.post(f"/api/v1/graph/agent/{agent.id}/use", json={"project_id": project.id})
    )
    [result] = await _session_results(bootstrapped_client, used["process_id"])
    assert result["exit_code"] == ExitCode.NOT_FOUND


@pytest.fixture(autouse=True)
def _no_leftover_tasks():
    yield
    for task in list(_DETACHED):
        if task.get_name().startswith("auto_open:") and not task.done():
            task.cancel()
