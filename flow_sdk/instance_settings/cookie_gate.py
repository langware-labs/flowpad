"""Per-instance cookie-gate secret — the one token this machine's backend is
locked with, and everything about how it is carried.

It lives in ``<instance_dir>/.cookie_gate`` (FLOWPAD-2233), created on first use
and read by the CLI and Electron. On a hub box ``flow auth set-cookie-gate`` (or
``/auth/login_callback?cookie-gate=``) overwrites it with the hub-minted secret, so
the hub, the box's own browser and its CLI all present one value.

The token's file and its wire format (header, query and cookie names and
attributes) stay in this module. Callers use:

* ``verify_cookie``     — does a request (or a presented string) carry the token
* ``get_header``        — the ``GateHeader(name, value)`` a machine caller sends
* ``add_query_param``   — a URL that carries the token once (``/auth/gate``)
* ``verify_query_param`` — does a request's URL itself carry the token
* ``set_cookie_header`` — the ``Set-Cookie`` value that hands a browser its cookie
* ``set_cookie`` / ``clear_cookie_gate`` — write / delete the token
* ``install_gate_opener`` — every urllib request in this process presents it
* ``CookieGateAuthHttpx`` — every request an httpx client sends presents it
* ``get_cookie_gate``   — the raw token, for the hub-signed caller check only

Keeping the token on this machine is the caller's job:
``flow_sdk.utils.networking.is_loopback`` tells it whether a host is this machine.
"""

from __future__ import annotations

import http.cookiejar
import logging
import os
import secrets
import urllib.request
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

import httpx
from starlette.datastructures import URL
from starlette.requests import HTTPConnection

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.utils.networking import is_loopback

logger = logging.getLogger(__name__)

# Machine callers present the token in this header.
_HEADER_NAME = "x-cookie-gate"
# A browser's first, cookie-less contact presents it in this query param.
_QUERY_NAME = "cookie-gate"
_TOKEN_FILENAME = ".cookie_gate"
# Per port: cookies ignore the port, so one name would let two local instances in
# the same browser overwrite each other's cookie.
_LOCAL_COOKIE_PREFIX = "cookie-gate-"
_LOCAL_COOKIE_MAX_AGE = 365 * 24 * 3600
# Through a hub box's public (https) URL.
_SANDBOX_COOKIE_NAME = "__Host-cookie-gate"


class GateHeader(NamedTuple):
    """The header a machine caller sends to this machine's backend."""

    name: str
    value: str


class DesktopGateRefused(ValueError):
    """Arming refused on a desktop-managed instance; a ``ValueError`` so the CLI reports it as a bad argument."""


def get_cookie_gate() -> str | None:
    """The raw token, or ``None`` when there is none (yet). For the hub-signed
    caller check (``service_endpoint``); everything else goes through the functions
    below. A plain-file read, so nothing is cached. Never raises."""
    try:
        value = _token_path().read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.warning("cookie-gate: cannot read token at %s: %s", _token_path(), e)
        return None
    return value or None


def set_cookie(value: str) -> None:
    """Write the token, replacing any token there.

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


def clear_cookie_gate() -> bool:
    """Delete the token file. Returns whether there was one."""
    try:
        _token_path().unlink()
    except FileNotFoundError:
        logger.debug("Cookie gate file deletion failed, file doesnt exists: %s", _token_path())
        return False
    return True


def verify_cookie(presented: HTTPConnection | str) -> bool:
    """Whether ``presented`` carries the token: a string compared as-is, or a request
    checked for the gate cookie, the ``X-Cookie-Gate`` header and the ``?cookie-gate=``
    query, each on its own so a stale cookie cannot veto a valid header or query."""
    token = _token()
    if not token:
        return False
    if isinstance(presented, str):
        candidates = (presented,)
    else:
        candidates = (
            presented.cookies.get(_cookie_name(presented.url.hostname, _request_port(presented))),
            presented.headers.get(_HEADER_NAME),
            presented.query_params.get(_QUERY_NAME),
        )
    return any(c and secrets.compare_digest(c, token) for c in candidates)


def get_header() -> GateHeader | None:
    """The header a machine caller sends to this machine's backend, or ``None``
    without a token. Send it to a loopback host only (``is_loopback``)."""
    token = _token()
    return GateHeader(_HEADER_NAME, token) if token else None


def add_query_param(url: URL) -> URL:
    """``url`` carrying the token as its query param — a browser's one cookie-less
    contact, which ``/auth/gate`` trades for the cookie. ``url`` unchanged without a token."""
    token = _token()
    return url.include_query_params(**{_QUERY_NAME: token}) if token else url


def verify_query_param(conn: HTTPConnection) -> bool:
    """Whether ``conn``'s URL itself carries the token as its query param, as only a URL
    built by ``add_query_param`` does. Unlike ``verify_cookie``, the cookie a browser
    attaches on its own does not count: the token in the URL is what shows the link was
    made by someone who holds it."""
    return verify_cookie(conn.query_params.get(_QUERY_NAME) or "")


def set_cookie_header(conn: HTTPConnection) -> str | None:
    """The ``Set-Cookie`` value that hands the browser behind ``conn`` the gate cookie
    for the host it addressed, or ``None`` without a token.

    On this machine: no ``Secure`` / ``__Host-`` (they add nothing on loopback, and
    Safari drops ``Secure`` cookies on ``http://localhost``), and ``SameSite=Lax`` —
    another site's fetch, form POST, iframe or subresource does not carry it, a
    top-level GET navigation does; the hub/provider redirects back to
    ``/auth/login_callback`` and ``/auth/oauth/*`` are cross-site, and ``Strict``
    refused them. Through a hub box's public URL: ``__Host-``, ``Secure``.
    """
    token = _token()
    if not token:
        return None
    host = conn.url.hostname
    name = _cookie_name(host, _request_port(conn))
    if is_loopback(host):
        return f"{name}={token}; Max-Age={_LOCAL_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax"
    return f"{name}={token}; Path=/; Secure; HttpOnly; SameSite=Lax"


class _GateCookieJar(http.cookiejar.CookieJar):
    """Presents this instance's token, as the gate cookie, on every urllib request
    to this machine's loopback hosts and nowhere else. Holds no cookies: the header
    is built per request (threads probing different ports cannot cross), and
    responses' ``Set-Cookie`` are not collected."""

    def add_cookie_header(self, request: urllib.request.Request) -> None:
        parts = urlsplit(request.full_url)
        token = _token() if is_loopback(parts.hostname) else None
        if token:
            request.add_unredirected_header("Cookie", f"{_cookie_name(parts.hostname, parts.port)}={token}")

    def extract_cookies(self, response, request) -> None:
        pass


def install_gate_opener() -> None:
    """Make every ``urllib.request.urlopen`` in this process present the token to this
    machine. Called once at startup by the processes that call the backend: the
    ``flow`` CLI, the function runner, the server monitor, and the backend itself (for code
    running in it, such as the in-app diagnose). The machine is not the boundary the gate
    guards -- anything running here can read the token file -- the browser is."""
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_GateCookieJar())))


class CookieGateAuthHttpx(httpx.Auth):
    """Presents this instance's token, as the ``X-Cookie-Gate`` header, on every request
    an httpx client sends to this machine's loopback hosts and nowhere else. Set once
    where the client is built: ``httpx.AsyncClient(auth=CookieGateAuthHttpx())``.

    It runs once per request, before httpx follows any redirect, and httpx strips only
    ``Authorization`` on a cross-origin redirect -- so a client that turns
    ``follow_redirects`` on would carry the token to wherever it is sent next. Leave
    redirects off on a client that uses this."""

    def auth_flow(self, request: httpx.Request):
        token = _token() if is_loopback(request.url.host) else None
        if token:
            request.headers[_HEADER_NAME] = token
        yield request


# ---------------------------------------------------------------------------
# Internals.
# ---------------------------------------------------------------------------


def _token_path() -> Path:
    """This instance's token file — the one the CLI and Electron read."""
    return get_instance_settings().instance_dir / _TOKEN_FILENAME


def _token() -> str | None:
    """The token, created on first use. ``None`` (and an error logged) when it can
    neither be read nor created: a gate then refuses rather than passing everything."""
    token = get_cookie_gate() or _create_token()
    if not token:
        logger.error("cookie-gate: no token at %s; refusing every request", _token_path())
    return token


def _create_token() -> str | None:
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


def _cookie_name(host: str, port: int) -> str:
    """The gate cookie's name for a request to ``host:port``."""
    return f"{_LOCAL_COOKIE_PREFIX}{port}" if is_loopback(host) else _SANDBOX_COOKIE_NAME


def _request_port(conn: HTTPConnection) -> int | None:
    """The port as the client addressed it (Host), else the socket's."""
    return conn.url.port or (conn.scope.get("server") or (None, None))[1]
