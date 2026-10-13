"""Per-instance cookie-gate secret — the one token this machine's backend is
locked with.

It lives in ``<instance_dir>/.cookie_gate`` (FLOWPAD-2233), the same file the
local gate creates on first use and that the CLI and Electron read. On a hub box
``flow auth set-cookie-gate`` (or ``/auth/login_callback?cookie-gate=``)
overwrites it with the hub-minted secret, so the hub, the box's own browser and
its CLI all present one value.
"""

from __future__ import annotations

import http.cookiejar
import logging
import os
import secrets
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from flow_sdk.instance_settings import get_instance_settings

logger = logging.getLogger(__name__)


class DesktopGateRefused(ValueError):
    """Raised when arming is attempted on a desktop-managed instance.

    A ``ValueError`` subclass so the CLI's existing handler reports it like any
    other bad argument, while ``/auth/login_callback`` can catch this case
    specifically and drop it without failing the login.
    """


LOCAL_TOKEN_FILENAME = ".cookie_gate"

#: This instance's token file — the one the CLI and Electron read.
LOCAL_TOKEN_PATH = get_instance_settings().instance_dir / LOCAL_TOKEN_FILENAME


def get_cookie_gate() -> str | None:
    """The secret this instance is gated on, or ``None`` when there is none (yet).

    A plain-file read, so nothing is cached. Never raises."""
    try:
        value = LOCAL_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
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
    # Renamed into place: a reader sees the old token or the new one, never a partial write.
    os.replace(_write_private_tmp(value), LOCAL_TOKEN_PATH)


def create_cookie_gate() -> str | None:
    """Write a fresh token unless one already exists, then return whatever is there.

    ``os.link`` refuses to replace an existing file, so when two processes race on
    first boot exactly one token survives and both read the same value back.
    ``None`` when the token cannot be created; never raises.
    """
    try:
        tmp = _write_private_tmp(secrets.token_urlsafe(32))
        try:
            os.link(tmp, LOCAL_TOKEN_PATH)
        except FileExistsError:
            pass  # a racing creator won; read its token below
        finally:
            tmp.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("cookie-gate: could not create local token at %s: %s", LOCAL_TOKEN_PATH, e)
        return None
    logger.info("cookie-gate: created local token at %s", LOCAL_TOKEN_PATH)
    return get_cookie_gate()


def _write_private_tmp(value: str) -> Path:
    """``value`` in a fresh temp file beside the token file. 0600 applies on posix;
    on Windows the file inherits the profile directory's ACL."""
    LOCAL_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOCAL_TOKEN_PATH.with_name(f"{LOCAL_TOKEN_FILENAME}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value)
    return tmp


def clear_cookie_gate() -> bool:
    """Delete the token file. Returns whether there was one."""
    try:
        LOCAL_TOKEN_PATH.unlink()
    except FileNotFoundError:
        return False
    return True


# Loopback hostnames. The secret is presented to these and nothing else: a
# caller can be pointed at a configured remote host, and a credential for THIS
# machine must never ride a request that leaves it.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


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
        from urllib.parse import urlsplit

        parts = urlsplit(url)
        if (parts.hostname or "") not in _LOOPBACK_HOSTS:
            return {}
        # Imported from the middleware that READS the header, so the two cannot drift.
        from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME

        secret = get_cookie_gate()
        if not secret:
            return {}
        return {HEADER_NAME: secret}
    except Exception:
        return {}


class _GateCookieJar(http.cookiejar.CookieJar):
    """Carries this instance's token, as the local gate's cookie, to this
    machine's loopback hosts and nowhere else. Refilled on every request: the
    token can be created or replaced after the opener is installed."""

    def add_cookie_header(self, request: urllib.request.Request) -> None:
        from flow_sdk.server.middleware.local_cookiegate_middleware import local_cookie_name  # noqa: PLC0415

        self.clear()
        token = get_cookie_gate()
        if token:
            name = local_cookie_name(urlsplit(request.full_url).port)
            # cookiejar files a dotless host such as localhost as "localhost.local".
            for domain in ("localhost.local", "127.0.0.1"):
                self.set_cookie(
                    http.cookiejar.Cookie(
                        version=0,
                        name=name,
                        value=token,
                        port=None,
                        port_specified=False,
                        domain=domain,
                        domain_specified=False,
                        domain_initial_dot=False,
                        path="/",
                        path_specified=True,
                        secure=False,
                        expires=None,
                        discard=True,
                        comment=None,
                        comment_url=None,
                        rest={"HttpOnly": None},
                        rfc2109=False,
                    )
                )
        super().add_cookie_header(request)


# Every ``urllib.request.urlopen`` in this process presents the token to this machine.
urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_GateCookieJar())))


def is_gated() -> bool:
    """The single predicate the middleware calls. ``True`` when this instance
    answers nothing without the secret."""
    return get_cookie_gate() is not None

