"""A command that follows its outcome on the socket (``flow agent deploy``) goes on when the server is slow to
answer; any other command still calls a silent server a failure. A real HTTP server that answers late."""

from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import click
import pytest

from flow_sdk.cli.commands._common import post_graph_json


class _Late(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        time.sleep(1.5)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status": "SUCCESS", "data": {"late": true}}')

    def log_message(self, *args):
        pass


@pytest.fixture
def late_url():
    server = HTTPServer(("127.0.0.1", 0), _Late)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/api/v1/graph/project/p/deploy"
    server.shutdown()


def _refused(status, body):
    raise AssertionError(f"refused {status} {body}")


@pytest.mark.long  # 1.5s: the server has to be slower than the wait
def test_a_followed_request_goes_on_when_the_answer_lags(late_url):
    assert post_graph_json(late_url, {}, on_error=_refused, timeout=1, answer_may_lag=True) == {}


@pytest.mark.long  # 1.5s
def test_any_other_request_still_fails_on_a_silent_server(late_url):
    with pytest.raises(click.exceptions.Exit) as ended:
        post_graph_json(late_url, {}, on_error=_refused, timeout=1)
    assert ended.value.exit_code == 5
