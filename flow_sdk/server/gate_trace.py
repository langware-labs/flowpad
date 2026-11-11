"""What the gate remembers about its recent admits, so a refusal can say what happened just before it.

A refusal alone cannot tell "this browser never got a cookie" from "this browser got one two
seconds ago and dropped it". Both look like ``cookie=missing``. So every successful ticket trade
is logged with a short id of the grant it minted, and remembered per client; a refusal then names
how long ago that client was admitted, which grant it should be carrying, and which cookie NAMES
(never values) actually arrived.

A client is its forwarded IP + user agent, hashed with a per-process salt: enough to match an
admit to the next request, useless for anything else, and never logged in the clear.

A refused page brings its scripts, styles and favicon with it: the first refusal per client and
cause is logged in full, the rest of that burst as a one-line pointer back to it.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from collections import OrderedDict
from typing import Optional
from urllib.parse import unquote, urlsplit

from starlette.requests import HTTPConnection

logger = logging.getLogger(__name__)

#: Fresh per process, like the grant key: client keys from another run mean nothing.
_SALT = secrets.token_hex(8)
#: How many clients' last admit is remembered. Old ones fall off first.
_MAX_CLIENTS = 512
#: A refusal this soon after the last full one, same client and cause, is the same page's burst.
BURST_SECONDS = 10.0

_admits: "OrderedDict[str, tuple[float, str]]" = OrderedDict()
_bursts: "OrderedDict[tuple[str, str], tuple[float, str]]" = OrderedDict()


def grant_id(value: Optional[str]) -> str:
    """A short, stable name for a grant value — its hash, never the value. Same id whether the
    value is as minted or percent-encoded as the browser returns it."""
    if not value:
        return "-"
    return hashlib.sha256(unquote(value).encode()).hexdigest()[:8]


def client_key(conn: HTTPConnection) -> str:
    forwarded = (conn.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = forwarded or (conn.client.host if conn.client else "?")
    agent = conn.headers.get("user-agent") or ""
    return hashlib.sha256(f"{_SALT}|{ip}|{agent}".encode()).hexdigest()[:8]


def referer_origin(conn: HTTPConnection) -> str:
    referer = conn.headers.get("referer") or ""
    host = urlsplit(referer).hostname if referer else None
    return host[:120] if host else "-"


def cookie_names(conn: HTTPConnection) -> str:
    """The names of the cookies that arrived — which tells "no cookies at all" from "not ours"."""
    names = sorted({part.split("=", 1)[0].strip() for part in (conn.headers.get("cookie") or "").split(";")} - {""})
    return ",".join(names)[:200] if names else "none"


def ticket_id(ticket: Optional[str]) -> str:
    """The id the hub logs for the ticket it handed out (``visitor-open: … ticket=``): sha256 of the ticket, 8 hex."""
    return hashlib.sha256(ticket.encode()).hexdigest()[:8] if ticket else "-"


def record_admit(
    conn: HTTPConnection, *, audience: str, caller: Optional[str], value: Optional[str], ticket: Optional[str] = None
) -> None:
    """Log and remember one successful ticket trade. ``ticket=`` joins this line to the hub's answer that issued it."""
    key = client_key(conn)
    gid = grant_id(value)
    _admits[key] = (time.monotonic(), gid)
    _admits.move_to_end(key)
    while len(_admits) > _MAX_CLIENTS:
        _admits.popitem(last=False)
    from flow_sdk.server.middleware.cookie_gate_middleware import short_browser  # noqa: PLC0415 -- cycle

    fetch = " / ".join(conn.headers.get(f"sec-fetch-{h}") or "-" for h in ("dest", "site", "mode"))
    logger.info(
        "cookie-gate: admitted door=%s visitor=%s ticket=%s grant=%s client=%s host=%s referer=%s fetch=%s browser=%s",
        audience,
        caller or "-",
        ticket_id(ticket),
        gid if value else "none(unarmed)",
        key,
        (conn.url.hostname or "?")[:120],
        referer_origin(conn),
        fetch.replace(" ", ""),
        short_browser(conn.headers.get("user-agent") or "").replace(" ", "_"),
    )


def refusal_facts(conn: HTTPConnection) -> dict[str, str]:
    """What happened before this refusal, for the log line and the page."""
    key = client_key(conn)
    facts = {"client": key, "cookies sent": cookie_names(conn), "referer": referer_origin(conn)}
    admitted = _admits.get(key)
    if admitted is None:
        facts["last admit"] = "none (this process, this client)"
    else:
        at, gid = admitted
        facts["last admit"] = f"{time.monotonic() - at:.1f}s ago, grant {gid}"
    return facts


def burst_of(client: str, cause: str, request_id: str) -> Optional[str]:
    """The request id this refusal repeats, or None when it should be logged in full (and becomes the new head)."""
    now = time.monotonic()
    head = _bursts.get((client, cause))
    if head is not None and now - head[0] < BURST_SECONDS:
        return head[1]
    _bursts[(client, cause)] = (now, request_id)
    _bursts.move_to_end((client, cause))
    while len(_bursts) > _MAX_CLIENTS:
        _bursts.popitem(last=False)
    return None


def reset_for_tests() -> None:
    _admits.clear()
    _bursts.clear()
