"""VIBE-003: a worker's `flow context list` must resolve ITS OWN project.

An agentic worker is launched from a browser tab and carries that tab's id in
`FLOWPAD_CONNECTION_ID` (injected in agentic_process.py). But `flow context list`
never reads it — it requests the *active* browser tab's context. So a headless
Vibe worker gets whichever tab the user happens to be looking at (the default
`my_first_project`), and the records workflow writes the new skill into that
wrong project. This test drives the real CLI targeting against the real backend
context endpoint and asserts the worker gets its own project's path.
"""

import asyncio
import json
import uuid

from flow_sdk.cli.commands import context_cmd
from flow_sdk.server.routes import navigate, websocket


class _FakeResp:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def _conn(ctx, *, visible, focused):
    return websocket.ConnectionInfo(
        ws=object(), visible=visible, focused=focused, browser_context=ctx
    )


def test_worker_context_uses_origin_connection_not_active_tab(monkeypatch, capsys):
    worker_path = "/private/tmp/flowpad-vibe-vw08-abc123"
    websocket._active_connections.clear()
    # The tab that launched the worker carries the worker's own temp project,
    # but it is NOT the currently visible/focused tab.
    websocket._active_connections["worker-origin"] = _conn(
        {"CurrentProjectTypeId": f"project-{uuid.uuid4()}", "CurrentProjectPath": worker_path},
        visible=False,
        focused=False,
    )
    # A different, currently-active tab pointing at the default project.
    websocket._active_connections["other-active"] = _conn(
        {
            "CurrentProjectTypeId": "project-@local",
            "CurrentProjectPath": "/Users/x/Flowpad workspace/my_first_project",
        },
        visible=True,
        focused=True,
    )

    # The worker knows the tab that launched it (agentic_process injects this).
    monkeypatch.setenv("FLOWPAD_CONNECTION_ID", "worker-origin")
    monkeypatch.setattr(context_cmd, "_discover_port", lambda: 1)

    # Wire the CLI's network boundary straight into the REAL context endpoint,
    # so backend selection (get_active_connection_info) runs for real.
    def _fake_get(url, params=None, timeout=None):
        cid = (params or {}).get("connection_id")
        return _FakeResp(asyncio.run(navigate.get_browser_context(connection_id=cid)))

    monkeypatch.setattr(context_cmd.requests, "get", _fake_get)

    # Exactly how the records workflow invokes it: no --connection-id.
    context_cmd.list_context()

    out = json.loads(capsys.readouterr().out)
    assert out["context"]["CurrentProjectPath"] == worker_path
