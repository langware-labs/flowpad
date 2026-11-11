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
import re
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
_bursts: "OrderedDict[tuple[str, tuple], tuple[float, str]]" = OrderedDict()


def short_id(value: Optional[str]) -> str:
    """A short, stable name for a grant or a ticket — 8 hex of its sha256, never the value. The same id whether
    the value is as minted or percent-encoded as a browser returns it; the hub logs the same id for the tickets it
    hands out (``visitor-open: … ticket=``), so its lines and this box's join on it."""
    return hashlib.sha256(unquote(value).encode()).hexdigest()[:8] if value else "-"


#: Kept for readers of the log: a grant's id and a ticket's id are the same function.
grant_id = ticket_id = short_id


def fetch_summary(conn: HTTPConnection, sep: str = " / ") -> str:
    """How the browser says it sent this request: ``Sec-Fetch-Dest / -Site / -Mode``."""
    return sep.join(conn.headers.get(f"sec-fetch-{h}") or "-" for h in ("dest", "site", "mode"))


def log_fields(facts: dict[str, str]) -> str:
    """``k=v`` pairs for one log line: spaces become ``_`` so each pair stays one token."""
    return " ".join(f"{k.replace(' ', '_')}={v.replace(' ', '_')}" for k, v in facts.items())


_BROWSERS = tuple(
    (re.compile(pattern), label)
    for pattern, label in (
        (r"CriOS/(\d+)", "Chrome iOS"),
        (r"FxiOS/(\d+)", "Firefox iOS"),
        (r"EdgiOS/(\d+)", "Edge iOS"),
        (r"Edg/(\d+)", "Edge"),
        (r"SamsungBrowser/(\d+)", "Samsung Internet"),
        (r"Firefox/(\d+)", "Firefox"),
        (r"Chrome/(\d+)", "Chrome"),
        (r"Version/(\d+)[\d.]* .*Safari/", "Safari"),
    )
)
_SYSTEMS = tuple(
    (re.compile(pattern), label)
    for pattern, label in (
        (r"(?:iPhone|iPad); CPU (?:iPhone )?OS (\d+)_(\d+)", "iOS"),
        (r"Android (\d+)", "Android"),
        (r"Mac OS X (\d+)_(\d+)", "macOS"),
        (r"Windows NT (\d+\.\d+)", "Windows"),
        (r"Linux", "Linux"),
    )
)


def short_browser(user_agent: str) -> str:
    """``Chrome iOS 157 / iOS 27.2`` from a user agent; an in-app WebView says so. Unknown parts are dropped."""
    ua = user_agent[:512]
    name = next(
        (f"{label} {m.group(1)}" for pattern, label in _BROWSERS if (m := pattern.search(ua))),
        "WebView" if "AppleWebKit" in ua and "Mobile/" in ua else "",
    )
    system = next(
        (f"{label} {'.'.join(m.groups())}".strip() for pattern, label in _SYSTEMS if (m := pattern.search(ua))),
        "",
    )
    apps = [app.rstrip("/") for app in ("WhatsApp", "Instagram", "FBAN", "Line/") if app in ua]
    if apps:
        name = f"{name} in {' in '.join(apps)}".strip()
    return " / ".join(p for p in (name, system) if p) or "unknown"


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


def record_admit(
    conn: HTTPConnection, *, audience: str, caller: Optional[str], value: Optional[str], ticket: Optional[str] = None
) -> None:
    """Log and remember one successful ticket trade. ``ticket=`` joins this line to the hub's answer that issued it."""
    key = client_key(conn)
    gid = short_id(value) if value else "none(unarmed)"
    _admits[key] = (time.monotonic(), gid)
    _admits.move_to_end(key)
    while len(_admits) > _MAX_CLIENTS:
        _admits.popitem(last=False)
    facts = {
        "door": audience,
        "visitor": caller or "-",
        "ticket": short_id(ticket),
        "grant": gid,
        "client": key,
        "host": (conn.url.hostname or "?")[:120],
        "referer": referer_origin(conn),
        "fetch": fetch_summary(conn, sep="/"),
        "browser": short_browser(conn.headers.get("user-agent") or ""),
    }
    logger.info("cookie-gate: admitted %s", log_fields(facts))


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


def burst_of(client: str, cause: tuple, request_id: str) -> Optional[str]:
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
