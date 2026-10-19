"""The grant a browser holds at one of this box's doors — minted here, from a ticket the hub signed.

A door is a listener a browser enters: the box's own UI (``system``, port 9007) and the two
audience proxies (``admin`` / ``app``, ``AUDIENCE_PORTS``). The hub decides who may enter which
(``admit`` on the hub) and hands the browser a TICKET — the grant subject signed with this box's
gate secret, good for a minute. The door verifies it with the secret it already holds and trades
it for a GRANT cookie: the same subject, signed with a key only this process knows
(``secret`` × a boot nonce), good for hours. The secret itself never rides a URL or a cookie.

Why the boot nonce: a restart invalidates every grant, so a box that comes back serves nobody
on a stale credential — every browser bounces through the hub once and is re-admitted or not.
That is also why the denylist (:func:`revoke`) need not persist: it only has to outlive the
grants it refuses, and those die with the process.

Three facts a door checks, in order: the signature (this box's), the audience (this door's), the
denylist (what the hub revoked since). The one exchange every door runs is :func:`exchange`.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import secrets
import time
from typing import Iterable, Optional
from urllib.parse import quote, unquote

from starlette.responses import RedirectResponse, Response

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server.service_proxy import GRANT_MAX_AGE, TICKET_MAX_AGE, Grant, sign_grant, verify_grant

#: The cookie a door sets. ``__Host-``: no Domain, so a cookie minted on one e2b port host is
#: never sent to another tenant's; Secure and Path=/ are implied by the prefix.
COOKIE_NAME = "__Host-grant"
#: The query parameter the ticket rides in, once: ``/auth/gate?ticket=…&next=…``.
TICKET_PARAM = "ticket"
#: The one path every door trades a ticket at.
GATE_PATH = "/auth/gate"
#: The platform's own prefix on a door; never the app's, never a landing.
RESERVED_PREFIX = "/__flowpad/"
#: Fresh per process: a restart invalidates every grant.
_BOOT_NONCE = secrets.token_hex(16)


def _secret() -> Optional[str]:
    return cookie_gate.get_cookie_gate()


@functools.lru_cache(maxsize=4)
def _grant_key(secret: str, nonce: str) -> str:
    """The key grants are signed with: the gate secret bound to THIS process's life."""
    return hmac.new(secret.encode(), f"flowpad.grant.{nonce}".encode(), hashlib.sha256).hexdigest()


def read_ticket(value: Optional[str], *, secret: Optional[str] = None, now: Optional[int] = None) -> Optional[Grant]:
    """The grant a hub ticket carries — verified with the gate secret — or None."""
    secret = secret or _secret()
    return verify_grant(value, secret, now=int(now or time.time()), max_age=TICKET_MAX_AGE) if secret else None


def mint_grant(grant: Grant, *, secret: Optional[str] = None, now: Optional[int] = None) -> Optional[str]:
    """The cookie value for *grant*, or None on an unarmed box (nothing to sign with)."""
    secret = secret or _secret()
    return sign_grant(grant, _grant_key(secret, _BOOT_NONCE), now=int(now or time.time())) if secret else None


def read_grant(value: Optional[str], *, secret: Optional[str] = None, now: Optional[int] = None) -> Optional[Grant]:
    """The grant a cookie carries — this process's signature, not revoked — or None."""
    secret = secret or _secret()
    if not secret or not value:
        return None
    moment = int(now or time.time())
    # The browser returns the cookie exactly as it was set: percent-encoded (``set_cookie_header``).
    grant = verify_grant(unquote(value), _grant_key(secret, _BOOT_NONCE), now=moment, max_age=GRANT_MAX_AGE)
    return None if grant is None or is_revoked(grant, now=moment) else grant


def set_cookie_header(value: str) -> str:
    """The ``Set-Cookie`` line for a grant.

    ``Partitioned`` (CHIPS): the app display embeds an audience door in an iframe on the box's own
    UI, a different port host; a partitioned cookie is the one a browser still keeps there. Browsers
    without CHIPS ignore the attribute. Session-scoped: closing the browser ends it, and the signature
    carries its own expiry anyway.
    """
    return f"{COOKIE_NAME}={quote(value, safe='')}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned"


def safe_next(candidate: Optional[str]) -> str:
    """A same-origin landing on a door, or its root.

    ``startswith("/")`` alone is not enough: ``//evil.com`` is a protocol-relative URL, which a
    browser follows straight off the origin. The platform's own prefix is never a landing either.
    """
    if not candidate or not candidate.startswith("/") or candidate.startswith(("//", RESERVED_PREFIX)):
        return "/"
    return candidate


def exchange(ticket: Optional[str], *, audience: str, landing: str) -> Optional[Response]:
    """The door's trade: a ticket for THIS door becomes its grant cookie and a 302 to *landing*.

    None when the ticket is not for this door (forged, stale, another audience's) — the caller
    says how that is refused. On an unarmed box there is nothing to sign with: the redirect
    happens without a cookie, so a stale link still lands in the app.
    """
    grant = read_ticket(ticket)
    if grant is None or grant.audience != audience:
        return None
    response = RedirectResponse(landing, status_code=302, headers={"Cache-Control": "no-store"})
    value = mint_grant(grant)
    if value:
        response.headers.append("set-cookie", set_cookie_header(value))
    return response


# ── what the hub revoked since ───────────────────────────────────────────────

#: ``(caller or None, endpoint id) → until``. None = every caller on that endpoint, the visitor's too.
_revoked: dict[tuple[Optional[str], str], float] = {}


def revoke(caller: Optional[str], endpoints: Iterable[str], *, now: Optional[float] = None) -> int:
    """Refuse *caller*'s grants (everyone's when None) on *endpoints* for as long as any could still be valid."""
    moment = float(now or time.time())
    endpoints = [str(endpoint) for endpoint in endpoints]
    for endpoint in endpoints:
        _revoked[(caller, endpoint)] = moment + GRANT_MAX_AGE
    for key in [k for k, until in _revoked.items() if until <= moment]:
        _revoked.pop(key, None)
    return len(endpoints)


def is_revoked(grant: Grant, *, now: Optional[float] = None) -> bool:
    moment = float(now or time.time())
    return any(
        (until := _revoked.get(key)) is not None and until > moment
        for key in ((grant.caller, grant.endpoint), (None, grant.endpoint))
    )


def reset_for_tests() -> None:
    _revoked.clear()


__all__ = [
    "COOKIE_NAME",
    "GATE_PATH",
    "RESERVED_PREFIX",
    "TICKET_PARAM",
    "exchange",
    "is_revoked",
    "mint_grant",
    "read_grant",
    "read_ticket",
    "revoke",
    "safe_next",
    "set_cookie_header",
]
