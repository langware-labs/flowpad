"""The pure half of the ``service`` proxy on this tier: header policy, upstream path, caller.

This tier's hop is the LAST one: FlowPad → the service, over loopback. A request
reaches it from the machine's own browser (desktop) or from the hub (a cloud box,
gate header attached). The service behind the endpoint is untrusted code, so:

* FlowPad's own credentials never reach it — the gate, the session cookie, an
  ``Authorization`` meant for FlowPad;
* it never sets cookies on FlowPad's origin (every endpoint is served on it here);
* the caller it is told about is one this tier VERIFIED: the hub signs
  ``X-Flowpad-Caller`` with the node's gate secret, and only a signature that
  checks out becomes ``X-Flowpad-User`` for the service. Anything a client sends
  under either name is dropped.

Deliberately not shared with the hub (``flowpad/hub/app/services/service_proxy.py``):
the two repos share no code. The caller signature format is the contract between
them and is pinned on both sides by its own tests.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from typing import Iterable, NamedTuple, Optional
from urllib.parse import quote

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.cloud_client.transport.proxy import _HOP as _HOP_BYTES
from flow_sdk.schema.data_spec.service_endpoint_spec import WEB_AUDIENCES

Headers = list[tuple[str, str]]

#: The hub's hop header: ``v1.<caller>.<ts>.<hmac>`` signed with the gate secret.
CALLER_HEADER = "x-flowpad-caller"
#: What the SERVICE is told: a caller this tier verified. Never taken from a client.
USER_HEADER = "x-flowpad-user"
GATE_HEADER = "x-cookie-gate"

#: RFC 7230 hop-by-hop headers — the transport proxy's own list, decoded.
_HOP = frozenset(name.decode("latin-1") for name in _HOP_BYTES)

_OUTBOUND_DROP = _HOP | {
    "host",
    "authorization",
    "cookie",
    GATE_HEADER,
    CALLER_HEADER,
    USER_HEADER,
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-prefix",
    "x-real-ip",
    "forwarded",
    # Local routing directives of this app, never the service's business.
    "hub-reflect",
    "x-flow-connection-id",
}

#: The relay performs its own upstream handshake. The caller's subprotocol offer is
#: passed to it separately (already parsed into the scope), so the header goes too.
_WEBSOCKET_DROP = frozenset(
    {
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-accept",
        "sec-websocket-protocol",
        "origin",
    }
)


def outbound_headers(headers: Iterable[tuple[str, str]], *, user: Optional[str], websocket: bool = False) -> Headers:
    """The request headers the service receives. ``user`` is an already-verified caller."""
    drop = _OUTBOUND_DROP | (_WEBSOCKET_DROP if websocket else frozenset())
    out: Headers = [(name.lower(), value) for name, value in headers if name.lower() not in drop]
    if user:
        out.append((USER_HEADER, user))
    return out


def inbound_headers(headers: Iterable[tuple[str, str]]) -> Headers:
    """The response headers the caller receives. Duplicates kept; never ``Set-Cookie``.

    Every endpoint is served on FlowPad's own origin on this tier, so a service's
    cookie would land in FlowPad's jar.
    """
    return [
        (name.lower(), value) for name, value in headers if name.lower() not in _HOP and name.lower() != "set-cookie"
    ]


_PATH_SAFE = "/:@!$&'()*+,;=-._~"

#: The ``service`` route, as mounted (``server/routes/service_endpoint.py``) — one spelling.
SERVICE_ROUTE_PREFIX = "/api/v1/graph"
SERVICE_ROUTE = "/service_endpoint/{endpoint_id}/service"


def service_path(endpoint_id: str) -> str:
    """``/api/v1/graph/service_endpoint/<id>/service/`` — where an endpoint is served on this tier."""
    return SERVICE_ROUTE_PREFIX + SERVICE_ROUTE.format(endpoint_id=endpoint_id) + "/"


def upstream_path(sub_path: str, query: str) -> str:
    """``/<sub>?<query>`` on the service. Refuses a dot segment — the service is
    addressed by its own root, and ``..`` is the one way to leave it."""
    sub = str(sub_path or "").lstrip("/")
    if any(segment in (".", "..") for segment in sub.split("/")):
        raise ValueError("dot segments are not allowed in a service path")
    path = "/" + quote(sub, safe=_PATH_SAFE)
    return f"{path}?{query}" if query else path


# ── the public base (where the BROWSER is) ──────────────────────────────────

_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d{1,5})?$")


def public_base(headers, *, gate_secret: Optional[str], scheme: str, host: str, endpoint_id: str) -> str:
    """The URL a static endpoint's page is served under, as the browser sees it — its ``<base>``.

    Without a hop in front, that is this tier's own endpoint root. Behind the hub
    it is wherever the HUB serves it — an origin of its own, or the hub's path —
    which only the hub knows and says with ``X-Forwarded-Host``/``-Proto``/``-Prefix``.
    Those are believed ONLY on the hub's gate-authenticated hop: from anyone else
    they would let a client move a page's assets to a host of its choosing. A
    malformed address falls back rather than being half-trusted.
    """
    own = f"{scheme}://{host}{service_path(endpoint_id)}"
    presented = headers.get(GATE_HEADER) or ""
    if not gate_secret or not hmac.compare_digest(presented, gate_secret):
        return own
    public_host = (headers.get("x-forwarded-host") or "").strip()
    prefix = (headers.get("x-forwarded-prefix") or "/").strip()
    proto = (headers.get("x-forwarded-proto") or "https").strip().lower()
    if not _HOST_RE.fullmatch(public_host) or proto not in ("http", "https"):
        return own
    if not prefix.startswith("/") or any(segment in (".", "..") for segment in prefix.split("/")):
        return own
    return f"{proto}://{public_host}{prefix if prefix.endswith('/') else prefix + '/'}"


# ── the caller signature (the contract with the hub) ────────────────────────

#: Same values as the hub's — a header minted there is checked here.
CALLER_MAX_AGE = 60
_CALLER_SKEW = 30
_CALLER_VERSION = "v1"
_CALLER_RE = re.compile(r"^[A-Za-z0-9_:@-]{1,200}$")
_MAX_HEADER = 1024


def _mac(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _sign(subject: str, secret: str, *, now: int) -> str:
    """``v1.<subject>.<ts>.<hmac>`` — the one framing every signed value on the wire uses."""
    if not secret:
        raise ValueError("cannot sign without a secret")
    message = f"{_CALLER_VERSION}.{subject}.{int(now)}"
    return f"{message}.{_mac(secret, message)}"


def _verify(value: Optional[str], secret: Optional[str], *, now: int, max_age: int) -> Optional[str]:
    """The subject a signed value carries, or None when forged, stale, junk — or there is no secret."""
    if not value or not secret or len(value) > _MAX_HEADER:
        return None
    parts = value.split(".")
    if len(parts) != 4 or parts[0] != _CALLER_VERSION:
        return None
    _, subject, ts, mac = parts
    if not ts.isdigit() or not hmac.compare_digest(mac, _mac(secret, f"{_CALLER_VERSION}.{subject}.{ts}")):
        return None
    age = int(now) - int(ts)
    if age > max_age or age < -_CALLER_SKEW:
        return None
    return subject


def sign_caller(caller: str, secret: str, *, now: int) -> str:
    """``v1.<caller>.<ts>.<hmac>``. The hub mints these; here only for tests and a symmetric contract."""
    if not _CALLER_RE.fullmatch(str(caller or "")):
        raise ValueError(f"{caller!r} cannot be carried as a caller")
    return _sign(caller, secret, now=now)


def verify_caller(
    value: Optional[str], secret: Optional[str], *, now: int, max_age: int = CALLER_MAX_AGE
) -> Optional[str]:
    """The caller a signed header names, or None when it is forged, stale, junk — or there is no secret."""
    caller = _verify(value, secret, now=now, max_age=max_age)
    return caller if caller is not None and _CALLER_RE.fullmatch(caller) else None


# ── the grant (one admission, carried as a ticket or kept as a cookie) ───────

#: The three browser doors a grant can name. ``system`` is the box's own UI (9007);
#: ``admin`` and ``app`` are the placement's two audience proxies.
SYSTEM_AUDIENCE = "system"
GRANT_AUDIENCES = (SYSTEM_AUDIENCE, *WEB_AUDIENCES)
#: The endpoint a ``system`` grant names when its minter has no row to point at (this box's own
#: CLI): the system door checks a grant's audience, never its row.
SYSTEM_ENDPOINT = "00000000-0000-4000-8000-000000000000"
#: A browser is sent to the box carrying a ticket once; it must cover the hop, no more.
TICKET_MAX_AGE = 60
#: How long a grant cookie admits a browser without returning to the hub.
GRANT_MAX_AGE = 12 * 60 * 60
#: Who a stamped-public endpoint admits without an identity.
VISITOR = "visitor"
_SUBJECT_SEP = "|"


class Grant(NamedTuple):
    """ONE admission: *caller* may enter *endpoint* through the *audience* door.

    The subject every door signs — a hub ticket, a box grant cookie, a hub audience
    session all carry this and nothing else. A grant for one endpoint opens no
    other, and one for the ``app`` door is refused at the ``admin`` one.
    """

    caller: str
    audience: str
    endpoint: str

    def encode(self) -> str:
        return _SUBJECT_SEP.join((self.caller, self.audience, self.endpoint))

    def is_valid(self) -> bool:
        """Whether every part can ride the wire: no separator inside, a known door, an id for an endpoint."""
        return bool(
            _CALLER_RE.fullmatch(self.caller) and self.audience in GRANT_AUDIENCES and is_valid_entity_id(self.endpoint)
        )

    @classmethod
    def decode(cls, subject: str) -> Optional["Grant"]:
        parts = str(subject or "").split(_SUBJECT_SEP)
        if len(parts) != 3:
            return None
        grant = cls(*parts)
        return grant if grant.is_valid() else None


def sign_grant(grant: Grant, secret: str, *, now: int) -> str:
    """``v1.<caller>|<audience>|<endpoint>.<ts>.<hmac>`` — the caller codec over a grant subject."""
    if not grant.is_valid():
        raise ValueError(f"{grant!r} cannot be carried as a grant")
    return _sign(grant.encode(), secret, now=now)


def verify_grant(value: Optional[str], secret: Optional[str], *, now: int, max_age: int) -> Optional[Grant]:
    """The grant a signed value carries, or None when forged, stale, malformed — or there is no secret."""
    subject = _verify(value, secret, now=now, max_age=max_age)
    return Grant.decode(subject) if subject is not None else None


__all__ = [
    "CALLER_HEADER",
    "CALLER_MAX_AGE",
    "GATE_HEADER",
    "GRANT_AUDIENCES",
    "GRANT_MAX_AGE",
    "Grant",
    "SYSTEM_AUDIENCE",
    "SYSTEM_ENDPOINT",
    "TICKET_MAX_AGE",
    "USER_HEADER",
    "VISITOR",
    "inbound_headers",
    "outbound_headers",
    "public_base",
    "sign_caller",
    "sign_grant",
    "upstream_path",
    "verify_caller",
    "verify_grant",
]
