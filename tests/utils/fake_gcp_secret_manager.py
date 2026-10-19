"""A Secret Manager v1 REST service, on a real loopback socket, holding secrets in memory.

**Why a server and not a stub.** What the ``gcp_secret_manager`` store can get wrong lives in the
wire: the ``:access`` / ``:addVersion`` verb suffixes, base64 payloads, the create-then-add-version
dance, the bearer header, ``nextPageToken`` pagination and the status codes. A stubbed client lets
every one of those pass — the same reasoning ``dummy_oauth_server`` records.

Implements only the endpoints the store speaks:

* ``GET    /v1/projects/{p}/secrets?pageSize&pageToken&filter=name:X`` — list (``filter`` substring)
* ``POST   /v1/projects/{p}/secrets?secretId=X`` — create (409 when it exists)
* ``POST   /v1/projects/{p}/secrets/{id}:addVersion`` — 404 when the secret is missing
* ``GET    /v1/projects/{p}/secrets/{id}/versions/latest:access`` — 404 when missing
* ``DELETE /v1/projects/{p}/secrets/{id}``

A bearer in ``tokens`` is let in, one in ``denied`` gets 403 ``PERMISSION_DENIED``, anything else
401 ``UNAUTHENTICATED``. A secret's ``name`` is reported with the project NUMBER, as Google does.
"""
from __future__ import annotations

import base64
import json
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator
from urllib.parse import parse_qs, urlparse

PROJECT_NUMBER = "123456789012"


@dataclass
class FakeSecretManager:
    tokens: set[str] = field(default_factory=set)
    denied: set[str] = field(default_factory=set)
    #: The most a list page returns, whatever ``pageSize`` asks — forces pagination in a test.
    page_size: int = 1000
    #: ``{(project, secret_id): [version payloads]}``.
    secrets: dict[tuple[str, str], list[bytes]] = field(default_factory=dict)
    #: ``(method, path)`` per request, in order.
    requests: list[tuple[str, str]] = field(default_factory=list)
    api_root: str = ""

    def put(self, project: str, secret_id: str, value: str) -> None:
        self.secrets.setdefault((project, secret_id), []).append(value.encode("utf-8"))


def _handler(state: FakeSecretManager, lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # quiet
            return

        def _send(self, status: int, body: dict) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _error(self, status: int, code: str) -> None:
            self._send(status, {"error": {"code": status, "status": code, "message": code.lower()}})

        def _authorized(self) -> bool:
            auth = self.headers.get("Authorization", "")
            token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
            if token in state.denied:
                self._error(403, "PERMISSION_DENIED")
                return False
            if token not in state.tokens:
                self._error(401, "UNAUTHENTICATED")
                return False
            return True

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")

        def _route(self, method: str) -> None:
            url = urlparse(self.path)
            state.requests.append((method, url.path))
            if not self._authorized():
                return
            parts = url.path.split("/")  # ['', 'v1', 'projects', p, 'secrets', rest?, ...]
            if parts[:3] != ["", "v1", "projects"] or len(parts) < 5 or parts[4] != "secrets":
                return self._error(404, "NOT_FOUND")
            project, rest = parts[3], parts[5:]
            query = parse_qs(url.query)
            with lock:
                if not rest and method == "GET":
                    return self._list(project, query)
                if not rest and method == "POST":
                    return self._create(project, query["secretId"][0])
                if len(rest) == 1 and rest[0].endswith(":addVersion") and method == "POST":
                    return self._add_version(project, rest[0][: -len(":addVersion")], self._body())
                if len(rest) == 3 and rest[1:] == ["versions", "latest:access"] and method == "GET":
                    return self._access(project, rest[0])
                if len(rest) == 1 and method == "DELETE":
                    return self._delete(project, rest[0])
            return self._error(404, "NOT_FOUND")

        def _list(self, project: str, query: dict) -> None:
            wanted = (query.get("filter") or [""])[0]
            needle = wanted[len("name:"):] if wanted.startswith("name:") else ""
            ids = sorted(sid for (p, sid) in state.secrets if p == project and needle in sid)
            size = min(int((query.get("pageSize") or ["25"])[0]), state.page_size)
            start = int((query.get("pageToken") or ["0"])[0])
            page = ids[start:start + size]
            body: dict = {"secrets": [{"name": f"projects/{PROJECT_NUMBER}/secrets/{sid}"} for sid in page]}
            if start + size < len(ids):
                body["nextPageToken"] = str(start + size)
            self._send(200, body)

        def _create(self, project: str, secret_id: str) -> None:
            if (project, secret_id) in state.secrets:
                return self._error(409, "ALREADY_EXISTS")
            state.secrets[(project, secret_id)] = []
            self._send(200, {"name": f"projects/{PROJECT_NUMBER}/secrets/{secret_id}"})

        def _add_version(self, project: str, secret_id: str, body: dict) -> None:
            versions = state.secrets.get((project, secret_id))
            if versions is None:
                return self._error(404, "NOT_FOUND")
            versions.append(base64.b64decode(body["payload"]["data"]))
            self._send(200, {"name": f"projects/{PROJECT_NUMBER}/secrets/{secret_id}/versions/{len(versions)}"})

        def _access(self, project: str, secret_id: str) -> None:
            versions = state.secrets.get((project, secret_id))
            if not versions:
                return self._error(404, "NOT_FOUND")
            data = base64.b64encode(versions[-1]).decode("ascii")
            self._send(200, {"name": f"projects/{PROJECT_NUMBER}/secrets/{secret_id}/versions/{len(versions)}",
                             "payload": {"data": data}})

        def _delete(self, project: str, secret_id: str) -> None:
            if state.secrets.pop((project, secret_id), None) is None:
                return self._error(404, "NOT_FOUND")
            self._send(200, {})

        def do_GET(self):  # noqa: N802
            self._route("GET")

        def do_POST(self):  # noqa: N802
            self._route("POST")

        def do_DELETE(self):  # noqa: N802
            self._route("DELETE")

    return Handler


@contextmanager
def serving_gcp_store(monkeypatch, **kwargs) -> Iterator[FakeSecretManager]:
    """A :class:`FakeSecretManager` on an ephemeral loopback port (``api_root`` is its ``/v1``), with
    the ``gcp_secret_manager`` store pointed at it."""
    from flow_sdk.secrets import gcp_secret_manager

    state = FakeSecretManager(**kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state, threading.Lock()))
    # The poll interval is how long ``shutdown`` waits for the loop to notice; the default 0.5s is
    # half a second of every test's teardown.
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    state.api_root = f"http://127.0.0.1:{server.server_address[1]}/v1"
    try:
        monkeypatch.setattr(gcp_secret_manager, "API_ROOT", state.api_root)
        yield state
    finally:
        server.shutdown()
        server.server_close()


__all__ = ["FakeSecretManager", "PROJECT_NUMBER", "serving_gcp_store"]
