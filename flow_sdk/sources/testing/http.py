"""``local_http_server`` — a real loopback socket for a source's wire tests.

A source is an HTTP client, so testing it honestly means real sockets — a stubbed client would let
the conditional-GET path pass without ever negotiating a 304. A responder is
``(path, request_headers) -> (status, body, headers)``; a POST body rides the headers as ``_body``.
Standard library only, so a data source asset's own tests import nothing but the SDK.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterator, Mapping

#: ``(path, request_headers) -> (status, body, response_headers)``
Responder = Callable[[str, Mapping[str, str]], "tuple[int, bytes, dict]"]


@contextmanager
def local_http_server(respond: Responder) -> Iterator[str]:
    """Serve ``respond`` on a loopback port; yields the base URL."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's contract
            self._answer(respond(self.path, self.headers))

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            seen = {k: v for k, v in self.headers.items()}
            seen["_body"] = raw.decode("utf-8", "replace")
            seen["_method"] = self.command
            self._answer(respond(self.path, seen))

        do_PUT = do_POST  # noqa: N815 — a body-carrying verb; `_method` tells the responder which

        def _answer(self, reply):
            status, body, headers = reply
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

    # THREADING, not the one-request-at-a-time HTTPServer: a client that opens a
    # connection and never finishes its request — an outbound send cancelled
    # mid-flight when a test cancels its loop task — parks the handler, and a
    # single-threaded `serve_forever` cannot then reach its own shutdown check.
    # Teardown blocked in `server.shutdown()` until pytest-timeout killed the
    # run (CI, test_3_variant_b_answers_on_the_channel). Handler threads are
    # daemons, so a parked one neither blocks `shutdown()` nor `server_close()`.
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    # A short shutdown poll: `serve_forever` checks for `shutdown()` once per interval.
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


__all__ = ["Responder", "local_http_server"]
