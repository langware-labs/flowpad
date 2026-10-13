"""Per-instance cookie-gate secret — the one token this machine's backend is
locked with, and everything about how it is carried.

It lives in ``<instance_dir>/.cookie_gate`` (FLOWPAD-2233), created on first use
and read by the CLI and Electron. On a hub box ``flow auth set-cookie-gate`` (or
``/auth/login_callback?cookie-gate=``) overwrites it with the hub-minted secret, so
the hub, the box's own browser and its CLI all present one value.

The token value, its file, and its wire format (header, query and cookie names
and attributes) stay in this module. The middlewares and routes ask it questions
— ``presents``, ``set_cookie_header``, ``gated_url``, ``is_loopback`` — and never
hold the value themselves.
"""

from __future__ import annotations

import http.cookiejar
import logging
import os
import secrets
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from flow_sdk.instance_settings import get_instance_settings

logger = logging.getLogger(__name__)

#: Machine callers present the token in this header.
HEADER_NAME = "x-cookie-gate"
#: A browser's first, cookie-less contact presents it in this query param.
QUERY_NAME = "cookie-gate"

_TOKEN_FILENAME = ".cookie_gate"
# Per port: cookies ignore the port, so one name would let two local instances in
# the same browser overwrite each other's cookie.
_LOCAL_COOKIE_PREFIX = "cookie-gate-"
_LOCAL_COOKIE_MAX_AGE = 365 * 24 * 3600
# Through a hub box's public (https) URL.
_SANDBOX_COOKIE_NAME = "__Host-cookie-gate"
# The secret is presented to these and nothing else: a credential for THIS
# machine must never ride a request that leaves it.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def is_loopback(host: str) -> bool:
    """Whether ``host`` is this machine."""
    return host in _LOOPBACK_HOSTS


def cookie_name(host: str, port: int) -> str:
    """The gate cookie's name for a request to ``host:port``."""
    return f"{_LOCAL_COOKIE_PREFIX}{port}" if is_loopback(host) else _SANDBOX_COOKIE_NAME


class DesktopGateRefused(ValueError):
    """Arming refused on a desktop-managed instance; a ``ValueError`` so the CLI reports it as a bad argument."""


def _token_path() -> Path:
    """This instance's token file — the one the CLI and Electron read."""
    return get_instance_settings().instance_dir / _TOKEN_FILENAME


def get_cookie_gate() -> str | None:
    """The secret this instance is gated on, or ``None`` when there is none (yet).

    A plain-file read, so nothing is cached. Never raises."""
    try:
        value = _token_path().read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.warning("cookie-gate: cannot read token at %s: %s", _token_path(), e)
        return None
    return value or None


def set_cookie_gate(value: str) -> None:
    """Write the secret to the token file, replacing any token there.

    Raises ``ValueError`` on an empty value, and ``DesktopGateRefused`` on a
    desktop-managed instance: its token is its own, never the hub's.
    """
    if not value:
        raise ValueError("cookie-gate secret must be non-empty")
    settings = get_instance_settings()
    if settings.desktop_marker_path.exists():
        raise DesktopGateRefused(
            f"Refusing to arm the cookie-gate on desktop-managed instance "
            f"{settings.instance_name!r}: a desktop keeps its own local token."
        )
    _write_token(value, os.O_TRUNC)


def create_cookie_gate() -> str | None:
    """Write a fresh token unless one already exists, then return whatever is there.

    ``O_EXCL`` refuses an existing file, so when two processes race on first boot
    exactly one token is written and both read it back. ``None`` when the token
    cannot be created; never raises.
    """
    try:
        _write_token(secrets.token_urlsafe(32), os.O_EXCL)
    except FileExistsError:
        pass  # a racing creator won; read its token below
    except OSError as e:
        logger.warning("cookie-gate: could not create local token at %s: %s", _token_path(), e)
        return None
    logger.info("cookie-gate: created local token at %s", _token_path())
    return get_cookie_gate()


def _write_token(value: str, mode: int) -> None:
    """Write ``value`` to the token file (0600 on posix; on Windows it inherits the
    profile directory's ACL). ``mode``: ``os.O_TRUNC`` to replace, ``os.O_EXCL`` to
    create only."""
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_CREAT | os.O_WRONLY | mode, 0o600), "w", encoding="utf-8") as f:
        f.write(value)


def clear_cookie_gate() -> bool:
    """Delete the token file. Returns whether there was one."""
    try:
        _token_path().unlink()
    except FileNotFoundError:
        return False
    return True


def ensure_cookie_gate() -> bool:
    """Whether this instance has a token, creating it on first use. ``False`` (and
    an error logged) when it can neither be read nor created: the gate then refuses
    every request rather than passing everything."""
    if get_cookie_gate() or create_cookie_gate():
        return True
    logger.error("cookie-gate: no token at %s; refusing every request", _token_path())
    return False


def presents(conn) -> bool:
    """Whether ``conn`` (a Starlette ``HTTPConnection``) carries the token as the gate
    cookie, the ``X-Cookie-Gate`` header or the ``?cookie-gate=`` query. Each is
    checked on its own, so a stale cookie cannot veto a valid header or query."""
    token = get_cookie_gate()
    if not token:
        return False
    for presented in (
        conn.cookies.get(cookie_name(conn.url.hostname, _request_port(conn))),
        conn.headers.get(HEADER_NAME),
        conn.query_params.get(QUERY_NAME),
    ):
        if presented and secrets.compare_digest(presented, token):
            return True
    return False


def set_cookie_header(conn) -> str | None:
    """The ``Set-Cookie`` value that hands the browser behind ``conn`` (a Starlette
    ``HTTPConnection``) the gate cookie for the host it addressed, or ``None`` when
    there is no token.

    On this machine: no ``Secure`` / ``__Host-`` (they add nothing on loopback, and
    Safari drops ``Secure`` cookies on ``http://localhost``), and ``SameSite=Lax`` —
    another site's fetch, form POST, iframe or subresource does not carry it, a
    top-level GET navigation does; the hub/provider redirects back to
    ``/auth/login_callback`` and ``/auth/oauth/*`` are cross-site, and ``Strict``
    refused them. Through a hub box's public URL: ``__Host-``, ``Secure``.
    """
    token = get_cookie_gate()
    if not token:
        return None
    host = conn.url.hostname
    name = cookie_name(host, _request_port(conn))
    if is_loopback(host):
        return f"{name}={token}; Max-Age={_LOCAL_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax"
    return f"{name}={token}; Path=/; Secure; HttpOnly; SameSite=Lax"


def gated_url(base_url: str, next_url: str) -> str:
    """``next_url`` entered through ``base_url``'s ``/auth/gate``: the browser presents
    the token once, is handed the gate cookie on that host, and goes on to
    ``next_url`` (a path there, or an absolute URL such as the hub login). A browser
    that never opened Flowpad then still carries the cookie when it comes back.
    Without a token, ``next_url`` itself (on ``base_url`` when it is a path)."""
    token = get_cookie_gate()
    if not token:
        return next_url if urlsplit(next_url).scheme else f"{base_url}{next_url}"
    return f"{base_url}/auth/gate?{urlencode({QUERY_NAME: token, 'next': next_url})}"


def _request_port(conn) -> int | None:
    """The port as the client addressed it (Host), else the socket's."""
    return conn.url.port or (conn.scope.get("server") or (None, None))[1]


def gate_headers(url: str) -> dict[str, str]:
    """The header a same-machine caller presents to get past flowpad's cookie gate.

    Empty for any non-loopback URL, and when this instance has no local token.

    This is the *machine* transport the middleware documents, and it lives here
    — beside the secret — rather than in any one caller, because there are
    several: the ``flow`` CLI (what an agent inside a gated sandbox runs), the
    discovery health probe, and the supervisor's. Each of them spelling it out
    separately is how the CLI came to have none at all, answering every command
    inside a gated sandbox with the gate's 403 HTML page.

    The header rather than ``?cookie-gate=``: a secret in a URL lands in access
    logs.

    It sends this instance's token (FLOWPAD-2233). One token per machine is the
    supported case: an end user runs one Flowpad, and dev setups that run
    several turn the local gate off.

    Any failure to resolve a secret degrades to no header, never to an
    exception: being unable to read the gate is a reason to call without it,
    never a reason to fail.
    """
    try:
        if not is_loopback(urlsplit(url).hostname):
            return {}
        secret = get_cookie_gate()
        if not secret:
            return {}
        return {HEADER_NAME: secret}
    except Exception:
        return {}


class _GateCookieJar(http.cookiejar.CookieJar):
    """Presents this instance's token, as the gate cookie, on every urllib request
    to this machine's loopback hosts and nowhere else. Holds no cookies: the header
    is built per request (threads probing different ports cannot cross), and
    responses' ``Set-Cookie`` are not collected."""

    def add_cookie_header(self, request: urllib.request.Request) -> None:
        parts = urlsplit(request.full_url)
        token = get_cookie_gate() if is_loopback(parts.hostname) else None
        if token:
            request.add_unredirected_header("Cookie", f"{cookie_name(parts.hostname, parts.port)}={token}")

    def extract_cookies(self, response, request) -> None:
        pass


def install_gate_opener() -> None:
    """Make every ``urllib.request.urlopen`` in this process present the token to this
    machine. Called once at startup by the processes that call the backend: the
    ``flow`` CLI and the function runner. The backend itself never does."""
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_GateCookieJar())))


def is_gated() -> bool:
    """The single predicate the middleware calls. ``True`` when this instance
    answers nothing without the secret."""
    return get_cookie_gate() is not None

