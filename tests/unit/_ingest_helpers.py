"""Shared scaffolding for the ingestion tests.

The drivers are HTTP clients, so testing them honestly means real sockets — a
stubbed client would let the conditional-GET path pass without ever negotiating
a 304, which is the one behaviour that makes an idle poll free. What the four
test modules do NOT each need is their own copy of the
``BaseHTTPRequestHandler`` / ``HTTPServer`` / daemon-thread boilerplate.

A responder is just ``(path, request_headers) -> (status, body, headers)``, which
covers every case the suite has: serving a fixture, ETag negotiation, JSON, and
error statuses.
"""
from __future__ import annotations

import threading
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Callable, Iterator, Mapping

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ingest"

#: ``(path, request_headers) -> (status, body, response_headers)``
Responder = Callable[[str, Mapping[str, str]], "tuple[int, bytes, dict]"]


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@contextmanager
def local_http_server(respond: Responder) -> Iterator[str]:
    """Serve ``respond`` on a loopback port; yields the base URL."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's contract
            status, body, headers = respond(self.path, self.headers)
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            # 304 must not carry a body or a Content-Length.
            if status != 304:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if status != 304 and body:
                self.wfile.write(body)

        def log_message(self, *args):  # keep test output clean
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def serve_fixture(name: str, *, headers: dict | None = None) -> Responder:
    """A responder that returns one fixture file for any path."""
    body = fixture_bytes(name)

    def respond(_path, _req_headers):
        return 200, body, dict(headers or {"Content-Type": "application/xml"})

    return respond


def make_data_source(provider: str = "rss", **fields):
    """A DataSource with a unique account key and the derived id already set.

    Every ingestion test needs this; without a shared factory the
    unique-key idiom gets retyped per file and one of them eventually forgets
    the deterministic id, silently testing a different code path.
    """
    from flow_sdk.builtin.data_source import DataSource

    resolved = {
        "provider": provider,
        "account_key": f"acct-{uuid.uuid4().hex[:8]}",
        "name": "test source",
    }
    resolved.update(fields)
    return DataSource(
        **resolved,
    )
