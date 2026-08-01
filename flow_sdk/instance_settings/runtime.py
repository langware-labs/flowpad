"""Per-instance runtime kind — the one place "what am I running on" is decided.

Every surface in the app reads ``BootstrapInfo.runtime.kind``. Nothing anywhere
else sniffs a hostname, a user-agent, an ``env_name`` literal, or the presence
of a bridge object to answer this question. There are exactly two inputs:

    electron   per REQUEST, from the bootstrap query param. The Electron
               preload bridge is the only thing that can know it is Electron,
               so the client tests for it and TELLS us — it does not decide.
    assigned   per INSTANCE, persisted here. The hub sets it over sandbox
               loopback when it launches us (``sandbox`` or ``agent``).

``assigned`` wins whenever it is set: an instance inside an E2B box cannot tell
from the inside that it is in one, but the hub that launched it knows for
certain. Absent an assignment we are a local install, and the only open
question is which client is asking.

Why ``assigned`` is persisted rather than passed as env: the hub's one
guaranteed channel into a running sandbox is the loopback
``/auth/login_callback`` it already curls (see ``cookie_gate``), and that fires
ONCE at launch, while ``bootstrap`` is called on every page load. Env would not
survive either — ``_restart_workspace_app`` on the hub side is skipped entirely
in production, where the app keeps running from the template snapshot.

Stored via ``app_config`` (``<instance_dir>/config.json``) — the same mutable,
plaintext, per-instance store ``privacy_mode`` uses. Deliberately NOT the sod:
this is not a secret. That an instance is a sandbox is something anyone holding
its public URL already knows; ``cookie_gate`` lives in the sod because it is a
pre-shared key, and copying that machinery here would buy nothing and cost a
keychain prompt.
"""

from __future__ import annotations

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.models.bootstrap_models import RuntimeInfo, RuntimeKind

_CONFIG_KEY = "runtime_kind"

# Only the hub may assign, and only these two: `desktop`/`browser` are decided
# per request from `electron`, and `hub` is what the hub's own bootstrap
# returns — an instance can never be told it is one of those.
_ASSIGNABLE: tuple[RuntimeKind, ...] = (RuntimeKind.SANDBOX, RuntimeKind.AGENT)

# In-process memo of the parsed assignment. ``app_config`` re-reads and re-parses
# config.json on every call and this sits on the bootstrap path, so it is cached.
#
# Keyed by instance_NAME, not instance_dir, so a process that switches
# FLOW_INSTANCE mid-run cannot read another instance's assignment — and for the
# reason ``cookie_gate`` spells out next door: ``instance_dir`` is a @property
# that builds a fresh Path per access, so its hash is never memoized and it
# measured ~34% of that function's cost. This one is on the bootstrap path too.
#
# ``None`` (no assignment — every desktop install, i.e. the common case) is a
# real cached value, so membership is tested with ``in`` rather than
# ``is not None``; otherwise the default case would never cache and would pay a
# file read on every bootstrap.
_cache: dict[str, RuntimeKind | None] = {}


def get_assigned_runtime() -> RuntimeKind | None:
    """What the hub told this instance it is, or ``None`` on a local install."""
    key = get_instance_settings().instance_name
    if key in _cache:
        return _cache[key]
    raw = app_config.get_config(_CONFIG_KEY)
    try:
        assigned = RuntimeKind(raw) if raw else None
    except ValueError:
        # An unknown value on disk is treated as no assignment rather than an
        # error: a config written by a newer build must not brick bootstrap.
        assigned = None
    if assigned is not None and assigned not in _ASSIGNABLE:
        assigned = None
    _cache[key] = assigned
    return assigned


def set_assigned_runtime(kind: RuntimeKind | str) -> RuntimeKind:
    """Persist the hub's assignment for this instance and return it.

    Raises ``ValueError`` for anything outside ``_ASSIGNABLE``. The sole caller
    is ``/auth/login_callback``, which must call this only AFTER the hub's
    api-key validates — otherwise any anonymous caller who can reach the port
    could relabel the instance.
    """
    assigned = RuntimeKind(kind)
    if assigned not in _ASSIGNABLE:
        raise ValueError(f"Runtime {assigned!r} is not assignable; expected one of {_ASSIGNABLE}")
    app_config.set_config(_CONFIG_KEY, assigned.value)
    _cache[get_instance_settings().instance_name] = assigned
    return assigned


def reset_cache() -> None:
    """Drop the memo. For tests, which move instance dirs under the module's feet."""
    _cache.clear()


def resolve_runtime(*, electron: bool = False) -> RuntimeInfo:
    """Build the aggregate for ONE bootstrap request.

    Called per request, never memoized: ``electron`` belongs to the caller, not
    to the server, and the same server answers both kinds of caller.
    """
    assigned = get_assigned_runtime()
    kind = assigned or (RuntimeKind.DESKTOP if electron else RuntimeKind.BROWSER)
    return RuntimeInfo(kind=kind, assigned=assigned, electron=electron, host="local")
