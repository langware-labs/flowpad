"""Per-instance runtime kind — the one place "what am I running on" is decided.

Every surface in the app reads ``BootstrapInfo.runtime.kind``. Nothing anywhere
else sniffs a hostname, a user-agent, an ``env_name`` literal, or the presence
of a bridge object to answer this question. There are exactly two inputs:

    electron   per REQUEST, from the bootstrap query param. The Electron
               preload bridge is the only thing that can know it is Electron,
               so the client tests for it and TELLS us — it does not decide.
    assigned   per INSTANCE, persisted here. The hub sets it over sandbox
               loopback when it launches us (``sandbox`` or ``agent``).

``assigned`` wins whenever it is set: the hub that launched the instance knows
for certain what it launched. Absent an assignment we are a local install, and
the only open question is which client is asking.

(An E2B box CAN in fact learn its own identity from the inside -- see
``own_sandbox_id`` below -- but that answers "which sandbox", not "am I one".
The kind stays the hub's to assign; an instance must not be able to promote
itself.)

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

from functools import lru_cache
from urllib.request import Request, urlopen

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.models.bootstrap_models import RuntimeInfo, RuntimeKind

_CONFIG_KEY = "runtime_kind"

# Firecracker's metadata service, which E2B fronts. Link-local: the answer comes
# from the hypervisor on this host, not across any network we share.
_MMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token"
_MMDS_INSTANCE_URL = "http://169.254.169.254/instanceID"
_MMDS_TIMEOUT_S = 2.0

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


@lru_cache(maxsize=1)
def own_sandbox_id() -> str | None:
    """WHICH sandbox this instance is, or ``None`` when it is not one.

    The companion to :func:`get_assigned_runtime`, which answers *whether*. Both
    live here so "what am I" has one home; the url built from this lives with
    the providers, which own url shapes.

    Deliberately NOT read from ``E2B_SANDBOX_ID``. E2B populates that variable
    only in the interactive shells it spawns; in the long-lived server process
    started at boot it is present and EMPTY. Measured on a live box -- the
    ``flow_sdk.server.run`` process reported ``E2B_SANDBOX_ID=`` while a terminal
    in the same sandbox reported the id. Reading it produced a fix that passed
    its test and changed nothing in production.

    Gated on the hub's assignment rather than on any local sniffing, per this
    module's rule: a desktop never pays for a link-local request that could only
    ever fail, and the sandbox-ness question keeps its single answer.

    Cached for the process lifetime: the id is fixed at boot, and callers sit on
    per-request paths.
    """
    if get_assigned_runtime() is not RuntimeKind.SANDBOX:
        return None
    try:
        token_req = Request(_MMDS_TOKEN_URL, method="PUT", headers={"X-metadata-token-ttl-seconds": "60"})
        with urlopen(token_req, timeout=_MMDS_TIMEOUT_S) as resp:
            token = resp.read().decode().strip()
        id_req = Request(_MMDS_INSTANCE_URL, headers={"X-metadata-token": token})
        with urlopen(id_req, timeout=_MMDS_TIMEOUT_S) as resp:
            return resp.read().decode().strip() or None
    except Exception:  # noqa: BLE001
        # Callers fall back to the loopback answer -- what they would have used
        # anyway. Not raised: a preview url is not worth failing bootstrap over.
        return None


def reset_cache() -> None:
    """Drop the memo. For tests, which move instance dirs under the module's feet."""
    _cache.clear()
    own_sandbox_id.cache_clear()


def resolve_runtime(*, electron: bool = False) -> RuntimeInfo:
    """Build the aggregate for ONE bootstrap request.

    Called per request, never memoized: ``electron`` belongs to the caller, not
    to the server, and the same server answers both kinds of caller.
    """
    assigned = get_assigned_runtime()
    kind = assigned or (RuntimeKind.DESKTOP if electron else RuntimeKind.BROWSER)
    return RuntimeInfo(kind=kind, assigned=assigned, electron=electron, host="local")
