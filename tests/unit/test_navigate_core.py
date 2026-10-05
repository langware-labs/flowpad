"""``flow_sdk.core.navigate`` — resolve, probe, and the verdict a navigation answers.

The probes run against a REAL local HTTP server on a free port (down, up, refusing to
be framed, failing), so "nothing answers" is the operating system's refusal, not a stand-in.
"""

from __future__ import annotations

import asyncio
import http.server
import socket
import threading
from contextlib import contextmanager

import pytest

from flow_sdk.core.navigate import navigate, pointer_for_web_url, probe_web_url, web_url_from_pointer
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

#: What the TS encoder (``pointerForWebUrl``) wrote into Spora's agent.json.
SPORA_POINTER = "url/aHR0cCUzQSUyRiUyRmxvY2FsaG9zdCUzQTMzMDAlMkY"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextmanager
def _server(*, status: int = 200, headers: dict | None = None):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — the stdlib's name
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(b"<html><title>app</title><body>hi</body></html>")

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}/"
    finally:
        srv.shutdown()
        srv.server_close()


def test_the_url_pointer_is_the_ts_encoders_twin():
    assert web_url_from_pointer(SPORA_POINTER) == "http://localhost:3300/"
    assert pointer_for_web_url("http://localhost:3300/") == SPORA_POINTER
    weird = "https://ü.example/a b?x=1&y=é"
    assert web_url_from_pointer(pointer_for_web_url(weird)) == weird


@pytest.mark.parametrize("pointer", ["url/!!!", "url/" + "ZmlsZTovLy9ldGMvcGFzc3dk", "service_endpoint-x", ""])
def test_anything_but_an_http_url_pointer_names_no_url(pointer):
    # the second is base64 of file:///etc/passwd — a scheme the display never opens
    assert web_url_from_pointer(pointer) is None


def test_nothing_listening_is_not_yet_not_running():
    code, verdict, detail = asyncio.run(probe_web_url(f"http://127.0.0.1:{_free_port()}/"))
    assert (code, verdict) == (ExitCode.NOT_YET, "not_running") and "Nothing is answering" in detail


def test_a_live_page_is_ok():
    with _server() as url:
        assert asyncio.run(probe_web_url(url))[:2] == (ExitCode.OK, "ok")


def test_a_page_that_refuses_framing_is_refused():
    with _server(headers={"X-Frame-Options": "DENY"}) as url:
        assert asyncio.run(probe_web_url(url))[:2] == (ExitCode.REFUSED, "frame_blocked")


def test_our_own_server_failing_is_not_yet_server_error():
    with _server(status=503) as url:
        assert asyncio.run(probe_web_url(url))[:2] == (ExitCode.NOT_YET, "server_error")


def test_a_404_is_not_a_verdict():
    """Spora Admin answers 404 on paths it renders fine; a status is never a reason to repair."""
    with _server(status=404) as url:
        assert asyncio.run(probe_web_url(url))[:2] == (ExitCode.OK, "ok")


def test_an_unknown_view_is_not_found_and_shows_nothing():
    answer = asyncio.run(navigate(DockPointerSpec(viewType="web-app", pointer="nonsense"), show=False))
    # web-app accepts any pointer; an unknown VIEW is the resolve failure
    assert answer.exit_code is ExitCode.OK
    bad = asyncio.run(navigate(DockPointerSpec.model_construct(viewType="no-such-view", pointer=""), show=False))
    assert bad.exit_code is ExitCode.NOT_FOUND and bad.delivered is False


@pytest.mark.parametrize("project_id", ["8d1f4c2e-3b6a-4f0e-9c7d-2a5b6e8f1d30", "not-an-id"])
def test_a_file_in_a_project_this_machine_lacks_is_not_found(project_id):
    spec = DockPointerSpec(viewType="project", pointer=f"p1/editor/html/vfs/project-{project_id}/index.html")
    answer = asyncio.run(navigate(spec, show=False))
    assert answer.exit_code is ExitCode.NOT_FOUND and "not on this machine" in answer.detail
