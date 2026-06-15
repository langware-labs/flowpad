"""Per-instance data-privacy mode — the single source of truth for whether
this instance is allowed to talk to the Flowpad cloud.

Two modes:
    "connected"  — sharing + cloud login enabled (default; today's behavior).
    "local"      — no data leaves the machine: cloud login, sharing, and all
                   outbound hub HTTP are disabled. Auto-update stays active.

This is a *hard* guarantee, enforced server-side. ``is_local_mode()`` is the
single predicate every backend gate calls (hub transport, cloud-auth routes,
hub reflection, share endpoints). Nothing else reads the stored value directly.

The value is runtime-mutable and persisted per-instance via ``app_config``
(``<instance_dir>/config.json``) — the same mutable store the user record lives
in — so it survives restarts and is readable by both backend and frontend
(seeded into the bootstrap payload).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings

PrivacyMode = Literal["local", "connected"]

_CONFIG_KEY = "privacy_mode"
_DEFAULT: PrivacyMode = "connected"
_VALID: tuple[PrivacyMode, ...] = ("local", "connected")

# In-process cache of the parsed mode. ``is_local_mode()`` runs on hot paths
# (every ``hub_base_url()`` and hub-reflect check), and ``app_config`` reads +
# parses ``config.json`` fresh on every call — so we memoize and invalidate on
# the single writer (``set_privacy_mode``). Keyed by instance_dir so a process
# that switches FLOW_INSTANCE mid-run can't read another instance's mode (the
# same per-instance discipline as the InstanceSettings cache).
_cache: dict[Path, PrivacyMode] = {}


def get_privacy_mode() -> PrivacyMode:
    """Return the current privacy mode for this instance (default ``connected``)."""
    key = get_instance_settings().instance_dir
    cached = _cache.get(key)
    if cached is not None:
        return cached
    value = app_config.get_config(_CONFIG_KEY, _DEFAULT)
    mode: PrivacyMode = value if value in _VALID else _DEFAULT
    _cache[key] = mode
    return mode


def set_privacy_mode(mode: PrivacyMode) -> PrivacyMode:
    """Persist ``mode`` for this instance and return the stored value.

    Raises ``ValueError`` on an unknown mode. Callers that want other open
    clients to update live should broadcast after calling this (see the
    cloud route that wraps it).
    """
    if mode not in _VALID:
        raise ValueError(f"Unknown privacy mode {mode!r}; expected one of {_VALID}")
    app_config.set_config(_CONFIG_KEY, mode)
    _cache[get_instance_settings().instance_dir] = mode
    return mode


def is_local_mode() -> bool:
    """The single predicate every backend cloud-access gate calls.

    ``True`` when this instance must not touch the cloud.
    """
    return get_privacy_mode() == "local"


async def apply_privacy_mode(mode: PrivacyMode) -> PrivacyMode:
    """Persist ``mode`` and broadcast it to local UI clients.

    The single funnel for privacy-mode transitions — mirrors
    ``auth_state.set_login_status``. Other open clients of this instance update
    their footer control + guards live, without a reload.
    """
    stored = set_privacy_mode(mode)
    try:
        from flow_sdk.api.messages import PrivacyModeMessage
        from flow_sdk.server.routes.websocket import broadcast

        await broadcast(PrivacyModeMessage(privacy_mode=stored).model_dump_json())
    except Exception:
        pass
    return stored
