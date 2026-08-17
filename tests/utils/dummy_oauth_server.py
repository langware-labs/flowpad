"""A real OAuth provider, on a real socket, that always says yes.

**Why a server and not a stub.** The bugs this harness exists to catch live in
the wire: a redirect URI that does not match, a `state` that is not echoed
byte-for-byte, a code replayed on a second exchange, a token endpoint that
wants a form body and gets JSON. A stubbed `httpx.AsyncClient` lets every one
of those pass. So this speaks HTTP, the same reasoning `_ingest_helpers`
records for its own socket server.

**Why not `_ingest_helpers.local_http_server`.** Its responder is
``(path, headers) -> (status, body, headers)``: no request body, so a token
endpoint (which is *entirely* a POST body) cannot be expressed, and no state, so
"this code was already exchanged" cannot be remembered. It is also unit-tier
scaffolding, and this is consumed from the api and hub tiers.

**What "dummy" removes is the human, not the protocol.** `/authorize` approves
without a consent screen, a password or a passkey — everything else is a real
authorization-code grant. That is the point: the flow under test is the real
one, minus the parts a test cannot click.

**It reports what it issued.** Because no token here is real, the server can
hand out its issuance log (`/_introspect`). That is what makes "the desktop, the
hub and the provider all hold the same value" an assertion about an actual value
rather than about a status field.

Every issued token is distinct — otherwise "latest login wins" is invisible,
and a stale token could pass by coinciding with the fresh one.
"""

from __future__ import annotations

import json
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterator, Optional
from urllib.parse import parse_qs, urlencode, urlparse

#: The hub tier needs a FIXED port: the hub is a separate, already-running
#: process whose plugin config is imported once and cached, so its `auth_url`
#: and `token_url` are frozen before any test picks a port. In-process tiers
#: pass 0 and get an ephemeral one.
DEFAULT_PORT = 6787


@dataclass
class _Issuance:
    n: int
    token: str
    code: str
    state: str
    redirect_uri: str
    client_id: str


@dataclass
class DummyOAuthState:
    """What the server has done. The test reads this instead of guessing."""

    issuances: list[_Issuance] = field(default_factory=list)
    rejections: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=lambda: {"authorize": 0, "token": 0, "userinfo": 0})
    #: code -> the request it was minted for. Popped on exchange, so a replay is
    #: a miss rather than a second token.
    outstanding: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def latest_token(self) -> Optional[str]:
        return self.issuances[-1].token if self.issuances else None

    def issued_tokens(self) -> list[str]:
        return [i.token for i in self.issuances]

    def reset(self) -> None:
        self.issuances.clear()
        self.rejections.clear()
        self.outstanding.clear()
        for key in self.counts:
            self.counts[key] = 0


class DummyOAuthServer:
    """Handle on a running server: its URL, and what it has issued."""

    def __init__(self, base_url: str, state: DummyOAuthState):
        self.base_url = base_url
        self.state = state

    # Endpoints, so a test never hand-builds one and drifts from the server.
    @property
    def authorize_url(self) -> str:
        return f"{self.base_url}/authorize"

    @property
    def token_url(self) -> str:
        return f"{self.base_url}/token"

    @property
    def userinfo_url(self) -> str:
        return f"{self.base_url}/userinfo"

    @property
    def latest_token(self) -> Optional[str]:
        return self.state.latest_token

    @property
    def counts(self) -> dict[str, int]:
        return dict(self.state.counts)

    def issued_tokens(self) -> list[str]:
        return self.state.issued_tokens()

    def reset(self) -> None:
        self.state.reset()


def _handler_class(
    state: DummyOAuthState,
    *,
    auto_approve: bool,
    state_mutator: Callable[[str], str],
    client_secret: str,
):
    class _Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # ── plumbing ──────────────────────────────────────────────────────
        def _send(self, status: int, payload: Any, *, headers: Optional[dict] = None) -> None:
            body = b"" if payload is None else json.dumps(payload).encode()
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            if body:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _reject(self, status: int, reason: str, **detail) -> None:
            state.rejections.append({"reason": reason, **detail})
            self._send(status, {"error": reason})

        def log_message(self, *args):  # keep test output readable
            pass

        # ── GET ───────────────────────────────────────────────────────────
        def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's contract
            parsed = urlparse(self.path)
            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}

            if parsed.path == "/authorize":
                return self._authorize(query)
            if parsed.path == "/userinfo":
                return self._userinfo()
            if parsed.path == "/_introspect":
                return self._send(
                    200,
                    {
                        "issuances": [i.__dict__ for i in state.issuances],
                        "latest_token": state.latest_token,
                        "counts": dict(state.counts),
                        "codes_outstanding": sorted(state.outstanding),
                        "rejections": list(state.rejections),
                    },
                )
            return self._send(404, {"error": "not_found"})

        def _authorize(self, query: dict[str, str]) -> None:
            state.counts["authorize"] += 1
            redirect_uri = query.get("redirect_uri") or ""
            # `state` is echoed byte-for-byte — the hub raises on any mismatch,
            # so the mutator is how a test forces that path without editing here.
            echoed = state_mutator(query.get("state") or "")
            if not redirect_uri:
                return self._reject(400, "missing_redirect_uri")

            if not auto_approve:
                # A refusal is still a redirect — that is how a provider says no.
                back = f"{redirect_uri}?{urlencode({'error': 'access_denied', 'state': echoed})}"
                state.rejections.append({"reason": "access_denied", "state": echoed})
                return self._send(302, None, headers={"Location": back})

            code = f"dmy_code_{len(state.outstanding) + len(state.issuances) + 1}"
            state.outstanding[code] = {
                "state": query.get("state") or "",
                "redirect_uri": redirect_uri,
                "client_id": query.get("client_id") or "",
            }
            back = f"{redirect_uri}?{urlencode({'code': code, 'state': echoed})}"
            self._send(302, None, headers={"Location": back})

        def _userinfo(self) -> None:
            state.counts["userinfo"] += 1
            auth = self.headers.get("Authorization") or ""
            token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
            if token and token in state.issued_tokens():
                return self._send(200, {"id": "dummy-user-1", "login": "dummyuser", "ok": True})
            return self._reject(401, "invalid_token")

        # ── POST ──────────────────────────────────────────────────────────
        def do_POST(self):  # noqa: N802
            parsed = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode() if length else ""

            if parsed.path == "/_reset":
                state.reset()
                return self._send(200, {"ok": True})
            if parsed.path != "/token":
                return self._send(404, {"error": "not_found"})

            state.counts["token"] += 1
            # Accept form-encoded (the RFC) or JSON — Anthropic's exchange posts
            # JSON, and refusing it here would be the harness inventing a rule.
            if raw.startswith("{"):
                try:
                    form = json.loads(raw)
                except ValueError:
                    return self._reject(400, "malformed_body")
            else:
                form = {k: v[0] for k, v in parse_qs(raw).items()}

            if form.get("grant_type") != "authorization_code":
                return self._reject(400, "unsupported_grant_type", got=form.get("grant_type"))

            code = form.get("code") or ""
            minted = state.outstanding.pop(code, None)
            if minted is None:
                # Covers both "never issued" and "already exchanged" — a code is
                # single-use, and a replay must not mint a second token.
                return self._reject(400, "invalid_grant", code=code)

            if form.get("redirect_uri") and form["redirect_uri"] != minted["redirect_uri"]:
                return self._reject(400, "redirect_uri_mismatch", got=form.get("redirect_uri"))
            if form.get("client_id") and form["client_id"] != minted["client_id"]:
                return self._reject(400, "invalid_client", got=form.get("client_id"))
            if client_secret and form.get("client_secret") not in (None, client_secret):
                return self._reject(400, "invalid_client_secret")

            n = len(state.issuances) + 1
            # Distinct per issuance, and unlike anything else in the fixtures —
            # so finding this exact string in SOD proves it travelled the chain.
            token = f"dmy_tok_{n}_{uuid.uuid4().hex[:8]}"
            state.issuances.append(
                _Issuance(
                    n=n,
                    token=token,
                    code=code,
                    state=minted["state"],
                    redirect_uri=minted["redirect_uri"],
                    client_id=minted["client_id"],
                )
            )
            self._send(
                200,
                {
                    "access_token": token,
                    "token_type": "bearer",
                    "scope": form.get("scope") or "read write",
                    "expires_in": 3600,
                },
            )

    return _Handler


@contextmanager
def dummy_oauth_server(
    *,
    port: int = 0,
    auto_approve: bool = True,
    state_mutator: Optional[Callable[[str], str]] = None,
    client_secret: str = "dummy-secret",
) -> Iterator[DummyOAuthServer]:
    """Run the dummy provider for the duration of the block.

    ``port=0`` takes an ephemeral port (in-process tiers); pass
    :data:`DEFAULT_PORT` when a separate process must reach it.

    ``auto_approve=False`` makes `/authorize` redirect with ``error=access_denied``,
    and ``state_mutator`` corrupts the echoed ``state`` — the two negative paths,
    available without editing the server.

    Threading, because in the hub tier two processes are in the chain (the test
    playing the browser, the hub doing the exchange) and a single-threaded server
    can stall on an overlapping request.
    """
    state = DummyOAuthState()
    handler = _handler_class(
        state,
        auto_approve=auto_approve,
        state_mutator=state_mutator or (lambda s: s),
        client_secret=client_secret,
    )
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield DummyOAuthServer(f"http://127.0.0.1:{httpd.server_port}", state)
    finally:
        httpd.shutdown()
        httpd.server_close()
