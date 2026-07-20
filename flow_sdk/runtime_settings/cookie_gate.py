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

from flow_sdk.runtime_settings import get_runtime_settings
from flow_sdk.runtime_settings.base_settings import SecretsNotEnabledError

_SECRET_NAME = "cookie_gate"

# In-process cache of the secret. The gate check runs on EVERY request and an
# uncached ``sod.read`` is a file read + Fernet decrypt + json.loads, so this is
# mandatory rather than nice-to-have.
#
# Keyed by instance_name so a process that switches FLOW_INSTANCE mid-run can't
# read another instance's secret — the same per-instance discipline privacy_mode
# keeps, but on a str rather than instance_dir. instance_dir is a @property that
# builds a fresh Path per access, so its hash is never memoized and it measured
# ~34% of this function's cost.
#
# Absence is cached too — ``None`` is a real, and by far the most common, value
# (every desktop install). Membership is tested with ``in``, not ``is not None``:
# a ``.get() is not None`` check would never cache the unset case and would pay a
# decrypt-and-fail on every single request.
_cache: dict[str, str | None] = {}


def _read() -> str | None:
    if not get_runtime_settings().cookie_gate_marker_path.exists():
        # Unarmed — the default, and every desktop install. Returning here on a
        # stat() is what keeps the sod, and therefore the keychain, untouched.
        return None
    try:
        return get_runtime_settings().sod.read(_SECRET_NAME)
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
    """The secret this instance is gated on, or ``None`` when it is not gated."""
    key = get_runtime_settings().instance_name
    if key in _cache:
        return _cache[key]
    value = _read() or None
    _cache[key] = value
    return value


def set_cookie_gate(value: str) -> None:
    """Persist the secret and arm the gate. The single writer.

    Raises ``ValueError`` on an empty value — arming on ``""`` would store a
    secret that ``is_gated()`` reads as unset, leaving the instance open while
    looking locked.
    """
    if not value:
        raise ValueError("cookie-gate secret must be non-empty")
    settings = get_runtime_settings()
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
    _cache[settings.instance_name] = value


def is_gated() -> bool:
    """The single predicate the middleware calls. ``True`` when this instance
    answers nothing without the secret."""
    return get_cookie_gate() is not None


def reset_cache() -> None:
    """Drop the memoized secret. For tests, and for any caller that rotates the
    sod out of band."""
    _cache.clear()
