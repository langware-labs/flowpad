"""The agent browser's MCP server, launched the way a session's MCP client launches it.

A session whose browser is ``agent`` gets one stdio MCP server, ``mcp_spec()``. The worker CLI
spawns that command, writes ``initialize`` to its stdin, and reads the process exiting as the
connection closing (Claude Code: ``agent_browser (CONNECTION_CLOSED)``, no browser tools).

No stand-ins: the real command, a real Chrome/Edge window, real Playwright MCP fetched by npx.
Browser bound and may download a package, so it lives in the long tier.

    DEEP_TESTING=1 uv run pytest tests/long_tests/test_agent_browser_mcp.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid

import psutil
import pytest

from flow_sdk.core import agent_browser
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing, reason="Skipping long tests when DEEP_TESTING is disabled"
)

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
}


def _kill_tree(pid: int | None) -> None:
    try:
        proc = psutil.Process(pid)
    except (psutil.Error, TypeError, ValueError):
        return
    for p in [*proc.children(recursive=True), proc]:
        try:
            p.kill()
        except psutil.Error:
            pass


def test_mcp_server_answers_initialize_and_stays_up(tmp_path):
    if agent_browser.find_browser() is None:
        pytest.skip("neither Chrome nor Edge is installed")
    if shutil.which("npx") is None:
        pytest.skip("npx (Node.js) is not installed")
    spec = agent_browser.mcp_spec()
    instance = f"test-{uuid.uuid4().hex[:8]}"
    env = {**os.environ, "FLOW_HOME": str(tmp_path), "FLOW_INSTANCE": instance}
    stderr = tmp_path / "server.err"
    with stderr.open("wb") as err:
        server = subprocess.Popen(
            [spec.command, *spec.args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, env=env
        )
    try:
        server.stdin.write((json.dumps(INITIALIZE) + "\n").encode())
        server.stdin.flush()
        reply = server.stdout.readline()
        if not reply:
            server.wait()
        log = stderr.read_text(errors="replace")[-600:]
        assert server.poll() is None, f"the server the client launched exited (rc={server.returncode}): {log}"
        assert json.loads(reply)["result"]["serverInfo"]["name"] == "Playwright", log
    finally:
        _kill_tree(server.pid)
        state = tmp_path / "instances" / instance / "browser" / "state.json"
        if state.exists():
            _kill_tree(json.loads(state.read_text()).get("pid"))
