"""`flow auth logout` signs out the FLOW_INSTANCE it was run for — and no other.

It used to post to ``get_instance_settings().port``: the port an instance BINDS to
(``LOCAL_SERVER_PORT``, else prod's 9007), not the one a running instance wrote to its
``server.json``. So ``FLOW_INSTANCE=sn-1 flow auth logout`` signed out prod, and the
logout's stream inbox purge took prod's stream inbox with it.

Two real HTTP servers stand in for the two backends: a decoy on the bind-port setting
and the instance's own on its ``server.json`` port. Nothing here can reach a real 9007.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from typer.testing import CliRunner

from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

INSTANCE = "logout-target-test"


class _Backend:
    """A loopback server that answers the health probe and records every POST path."""

    def __init__(self) -> None:
        posts: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self._reply(200 if self.path == "/health/status" else 404)

            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                posts.append(self.path)
                self._reply(200)

            def _reply(self, code: int) -> None:
                body = json.dumps({"status": "SUCCESS", "data": {}}).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.posts = posts
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def instance(tmp_path, monkeypatch):
    decoy, own = _Backend(), _Backend()
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow"))
    monkeypatch.setenv("FLOW_INSTANCE", INSTANCE)
    monkeypatch.setenv("LOCAL_SERVER_PORT", str(decoy.port))
    reset_instance_settings()

    from flow_sdk.cli.app_config import set_user

    set_user({"id": "u-1", "email": "someone@local.test"})
    yield decoy, own
    decoy.close()
    own.close()
    reset_instance_settings()


def _logout() -> str:
    from flow_sdk.cli.flow_cli import app

    result = CliRunner().invoke(app, ["auth", "logout"])
    assert result.exit_code == 0, result.output
    return result.output


def test_logout_posts_to_the_running_instance_not_the_bind_port(instance):
    decoy, own = instance
    settings = get_instance_settings()
    settings.server_json_path.parent.mkdir(parents=True, exist_ok=True)
    settings.server_json_path.write_text(json.dumps({"port": own.port}))

    _logout()

    assert own.posts == ["/api/v1/cloud/logout"]
    assert decoy.posts == []


def test_logout_without_a_running_instance_clears_locally(instance):
    decoy, own = instance

    output = _logout()

    from flow_sdk.cli.app_config import get_user

    assert not get_user()
    assert decoy.posts == [] and own.posts == []
    assert "Successfully logged out" in output
