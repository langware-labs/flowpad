"""Per-instance cookie-gate secret — the pre-shared key that locks this
instance to callers who can prove they were sent here.

Unset (the default, and every desktop install) the instance behaves exactly as
it always has. Set, ``CookieGateMiddleware`` answers nothing without it — not
the UI, not static, not the API, not a WebSocket.

The secret arrives on ``/auth/login_callback``, which the hub curls over sandbox
loopback to deliver the api-key. That request is invisible to the sandbox's
public URL, which is what makes it a usable provisioning channel. Persisting it
arms the gate; there is no other writer.

Stored in the per-instance sod (0600, Fernet, atomic locked writes) next to the
api-key it ships with — not ``config.json``, which is plaintext and whose writes
are neither atomic nor locked. Written through ``instance.sod`` directly rather
than ``cli.auth.secrets.write_secret`` so it stays out of the app_secret record
list: this is an internal gate value, not a user-managed secret.

Read on every request, so the parsed value is memoized per instance_dir — the
same discipline as ``privacy_mode`` (and for the same reason: an uncached read
here is a full file decrypt).

**An armed marker file guards the sod read, and it is load-bearing.** Decrypting
the sod fetches the Fernet key, which on a normal install means an OS keychain
prompt (``file_sod._cipher`` — "the single point that actually fetches the key").
``sod.read`` only short-circuits when the sodot file is *absent*, and a logged-in
instance always has one. So consulting the sod to discover we are ungated would
prompt the keychain on the first HTTP request after every restart — on desktop
installs that are never gated at all. The marker answers "is this instance armed"
from a stat() alone, which is the same trick ``hub_login.is_logged_in`` uses to
stay "safe to call at startup without triggering a keychain access prompt", and
the same shape as the ``.secrets_enabled`` consent marker. It holds no secret:
that an instance is gated is something an attacker learns from the Forbidden page
anyway.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.instance_settings.base_settings import SecretsNotEnabledError

_SECRET_NAME = "cookie_gate"


class DesktopGateRefused(ValueError):
    """Raised when arming is attempted on a desktop-managed instance.

    A ``ValueError`` subclass so the CLI's existing handler reports it like any
    other bad argument, while ``/auth/login_callback`` can catch this case
    specifically and drop it without failing the login.
    """


# In-process cache of the secret. The gate check runs on EVERY request and an
# uncached ``sod.read`` is a file read + Fernet decrypt + json.loads, so this is
# mandatory rather than nice-to-have.
#
# Keyed by instance_name so a process that switches FLOW_INSTANCE mid-run can't
# read another instance's secret — the same per-instance discipline privacy_mode
# keeps, but on a str rather than instance_dir.
#
# The value is ``(marker mtime_ns, secret)``, and the mtime is what makes the
# entry falsifiable. This used to cache the answer outright, absence included,
# on the reasoning that ``None`` is the common case and re-checking would cost a
# decrypt per request. True as far as it went — but it also meant a gate armed by
# ANOTHER process was invisible: the file changed and the server kept serving a
# memoized ``None``, enforcing nothing until it restarted. That is not
# theoretical now that the hub arms the gate with `flow auth set-cookie-gate`
# rather than a call into this process. Comparing an mtime keeps the decrypt
# rare (only when the marker actually moves) without letting the cache outlive
# the truth.
_cache: dict[str, tuple[int, str | None]] = {}

# Memoized marker paths, per the ~34% measurement noted above.
_marker_paths: dict[str, Path] = {}


def _read() -> str | None:
    if not get_instance_settings().cookie_gate_marker_path.exists():
        # Unarmed — the default, and every desktop install. Returning here on a
        # stat() is what keeps the sod, and therefore the keychain, untouched.
        return None
    try:
        return get_instance_settings().sod.read(_SECRET_NAME)
    except SecretsNotEnabledError:
        # Under FLOWPAD_DESKTOP=1 the sod key must be seeded by Electron before
        # it can be read. Resolve to "not gated" rather than failing closed —
        # desktop is the case that is never gated in the first place, and
        # bricking every request over a keychain handoff is the worse failure.
        return None
    except Exception:
        # A corrupt or unreadable sod resolves to "not gated" for the same
        # reason. Documented in docs/cookie-gate.md; revisit if the gate ever
        # protects something other than a public sandbox URL.
        return None


def get_cookie_gate() -> str | None:
    """The secret this instance is gated on, or ``None`` when it is not gated.

    Re-checks the marker on EVERY call and re-reads only when its mtime moved.
    The plain "cache the answer forever" version could not see a gate armed by
    another process, which is what a `flow auth set-cookie-gate` from the hub
    is: the file changed and this server kept serving a memoized ``None``,
    enforcing nothing until it restarted. The window that opens is exactly the
    one the gate exists to close, so the stat is worth it.

    The cost is one ``stat`` per request, which is what the unarmed path already
    paid inside ``_read``; what is new is paying it when armed too. Nothing else
    changed: the sod is still opened only when the marker's mtime actually
    moves, so a steady-state gated instance decrypts once, and an ungated one
    (every desktop install) still never touches the keychain.
    """
    settings = get_instance_settings()
    key = settings.instance_name
    try:
        # Memoized per instance: `cookie_gate_marker_path` derives from
        # `instance_dir`, a @property that builds a fresh Path per access and
        # measured ~34% of this function's cost. Statting a cached Path keeps
        # the per-request work to the syscall itself.
        marker = _marker_paths.get(key)
        if marker is None:
            marker = settings.cookie_gate_marker_path
            _marker_paths[key] = marker
        mtime = marker.stat().st_mtime_ns
    except OSError:
        # No marker (or unreadable) — unarmed, the common case. Drop any cached
        # secret so a cleared gate stops being enforced without a restart.
        _cache.pop(key, None)
        return None

    cached = _cache.get(key)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    value = _read() or None
    _cache[key] = (mtime, value)
    return value


def set_cookie_gate(value: str) -> None:
    """Persist the secret and arm the gate. The single writer.

    Raises ``ValueError`` on an empty value — arming on ``""`` would store a
    secret that ``is_gated()`` reads as unset, leaving the instance open while
    looking locked.

    Raises ``DesktopGateRefused`` on a desktop-managed instance. The gate exempts
    no path, so arming one is indistinguishable from bricking the app: the
    Electron shell's own ``/health/status`` poll gets the 403 like everyone else,
    never sees the backend it just spawned come up, and kills it after 120s. The
    gate exists to protect a sandbox's public URL; a desktop install has no
    public URL to protect, so there is no case where arming one is correct.

    The check lives here, in the single writer, rather than in either caller —
    the CLI command and ``/auth/login_callback`` are both writers today and a
    rule enforced in one of them is a rule the other can still break.
    """
    if not value:
        raise ValueError("cookie-gate secret must be non-empty")
    settings = get_instance_settings()
    if settings.desktop_marker_path.exists():
        raise DesktopGateRefused(
            f"Refusing to arm the cookie-gate on desktop-managed instance "
            f"{settings.instance_name!r}: the gate exempts no path, so it would "
            f"reject the desktop app's own health check and prevent it from "
            f"launching. The gate is for sandboxes reachable at a public URL."
        )
    # sod.write has no mkdir of its own, and its FileLock needs the dir to exist.
    # It does today only because _finalize_login runs enable_secrets() first —
    # not something a public setter should depend on. Same shape as
    # base_settings' own marker write.
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    settings.sod.write(_SECRET_NAME, value)
    # Marker last: it is what makes the secret discoverable, so writing it before
    # the sod would open a window where the gate reads as armed but has nothing
    # to compare against — which fails open, silently.
    #
    # 0600 to match every other artifact in instance_dir. It holds no secret, but
    # a lone 0644 file among 0600 siblings is the kind of exception that needs a
    # reason, and there isn't one.
    settings.cookie_gate_marker_path.touch(mode=0o600)
    # Stamp the cache with the marker we just wrote, so this process does not
    # re-read the sod it already knows the contents of. Read the mtime back
    # rather than assuming: it is the value every other reader will compare.
    try:
        _cache[settings.instance_name] = (settings.cookie_gate_marker_path.stat().st_mtime_ns, value)
    except OSError:
        _cache.pop(settings.instance_name, None)


def clear_cookie_gate() -> bool:
    """Disarm the gate. The single deleter, mirroring ``set_cookie_gate``.

    Returns whether anything was armed to begin with, so a caller can report
    "already open" instead of implying it changed something.

    Order is the EXACT REVERSE of arming, and for the same reason. Arming writes
    the secret first and the marker last, so the gate is never discoverable
    before there is something to compare against. Disarming therefore removes
    the MARKER first: from that instant ``_read`` short-circuits on the stat and
    the instance is open, with the now-unreferenced secret cleaned up after.
    Deleting the secret first would leave a window where the marker still says
    "armed" while the comparison value is gone — and ``_read`` resolves an
    unreadable store to ``None``, i.e. it fails OPEN. Same end state, but
    reached through a moment that silently looks locked and is not.
    """
    settings = get_instance_settings()
    was_armed = settings.cookie_gate_marker_path.exists()

    settings.cookie_gate_marker_path.unlink(missing_ok=True)
    try:
        settings.sod.delete(_SECRET_NAME)
    except Exception:
        # The marker is gone, so the instance is already open — which is the
        # whole point of the call. A secret left behind in the store is inert:
        # nothing reads it without the marker, and re-arming overwrites it.
        pass

    # The running server memoizes per instance_name; without this it would keep
    # enforcing a gate whose marker no longer exists until the process restarts.
    _cache.pop(settings.instance_name, None)
    return was_armed


# Loopback hostnames. The secret is presented to these and nothing else: a
# caller can be pointed at a configured remote host, and a credential for THIS
# machine must never ride a request that leaves it.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def gate_headers(url: str) -> dict[str, str]:
    """The header a same-machine caller presents to get past its own gate.

    Empty for an unarmed instance (which is every desktop install) and for any
    non-loopback URL.

    This is the *machine* transport the middleware documents, and it lives here
    — beside the secret — rather than in any one caller, because there are
    several: the ``flow`` CLI (what an agent inside a gated sandbox runs), the
    discovery health probe, and the supervisor's. Each of them spelling it out
    separately is how the CLI came to have none at all, answering every command
    inside a gated sandbox with the gate's 403 HTML page.

    The header rather than ``?cookie-gate=``: a secret in a URL lands in access
    logs.

    Free when unarmed — ``get_cookie_gate`` answers from a ``stat()`` of the
    marker file and never opens the encrypted store, which is what keeps desktop
    installs away from a keychain prompt. Starlette is imported only on the
    armed path, so an ordinary call does not pay for it. Any failure to resolve
    the secret degrades to no header, never to an exception: being unable to
    read the gate is a reason to call without it, never a reason to fail.
    """
    try:
        from urllib.parse import urlsplit

        if (urlsplit(url).hostname or "") not in _LOOPBACK_HOSTS:
            return {}
        secret = get_cookie_gate()
        if not secret:
            return {}
        # Imported from the middleware that READS the header so the two cannot
        # drift; deferred so the ungated path never pulls in starlette.
        from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME

        return {HEADER_NAME: secret}
    except Exception:
        return {}


def is_gated() -> bool:
    """The single predicate the middleware calls. ``True`` when this instance
    answers nothing without the secret."""
    return get_cookie_gate() is not None


def reset_cache() -> None:
    """Drop the memoized secret. For tests, and for any caller that rotates the
    sod out of band.

    Clears the marker paths too: they are keyed by instance NAME, so a caller
    that repoints the same name at a different ``FLOW_HOME`` (which is what a
    test fixture does) would otherwise keep statting the old directory and read
    a gate that no longer applies.
    """
    _cache.clear()
    _marker_paths.clear()
