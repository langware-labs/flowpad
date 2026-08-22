"""Shared contracts and callback delivery for process-scoped worker hooks.

The registry is keyed by entity identity, not ``AgenticProcess`` object
identity: webhook delivery normally rehydrates a fresh entity instance. Hook
configuration is persisted on the entity; Python callbacks intentionally are
not.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import Any

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.hooks import callbacks as _callbacks
from flow_sdk.builtin.hooks.callbacks import AgentHookCallback
from flow_sdk.builtin.hooks.capabilities import PROCESS_EVENTS
from flow_sdk.builtin.hooks.types import HookEventType
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData

logger = logging.getLogger(__name__)

#: Deprecated alias for ``AgentHookCallback``.
ProcessHookCallback = AgentHookCallback

#: Re-exported so there is ONE definition of the process event set.
SUPPORTED_PROCESS_HOOK_EVENTS = PROCESS_EVENTS


def normalize_process_hook_events(
    events: Sequence[HookEventType | str],
    *,
    provider: str,
) -> tuple[HookEventType, ...]:
    """Validate and order the process-hook events supported by every V1 driver."""
    try:
        normalized = {event if isinstance(event, HookEventType) else HookEventType(event) for event in events}
    except ValueError as exc:
        raise ValueError(f"Unsupported {provider.capitalize()} process hook event: {events!r}") from exc
    unsupported = normalized - SUPPORTED_PROCESS_HOOK_EVENTS
    if unsupported:
        names = ", ".join(sorted(event.value for event in unsupported))
        raise ValueError(f"Unsupported {provider.capitalize()} process hook event: {names}")
    return tuple(sorted(normalized, key=lambda event: event.value))


def build_process_hook_snapshot(
    events: Sequence[HookEventType | str],
    *,
    provider: str,
) -> dict[str, Any]:
    """Return the path-independent semantic restart payload for one provider."""
    normalized = normalize_process_hook_events(events, provider=provider)
    if not normalized:
        return {}
    return {
        "events": [event.value for event in normalized],
        "provider": provider,
        "schema": 2,
    }


def build_canonical_hook_data(
    process_id: str,
    raw_hook_data: dict[str, Any],
    *,
    fields: Sequence[str],
) -> AgentHookData:
    """Project one vendor-native report onto the canonical hook fields.

    Field NAMES are canonicalized here; VALUES never are — each vendor keeps
    its own ``source``/``reason`` vocabulary, and the untouched native object
    stays in ``raw_hook_data``.
    """
    if not is_valid_entity_id(process_id):
        raise ValueError(f"Invalid agentic process id: {process_id!r}")
    raw = dict(raw_hook_data)
    hook_data: dict[str, Any] = {key: raw[key] for key in fields if key in raw}
    hook_data["raw_hook_data"] = raw
    return AgentHookData(agentic_process_id=process_id, hook_data=hook_data)


def register_process_hook_callback(
    process_id: str,
    callback: ProcessHookCallback,
) -> Callable[[], None]:
    """Deprecated alias — use ``process.hooks.set_callback``."""
    return _callbacks.register(str(process_id), callback)


async def dispatch_process_hook(process_id: str, data: AgentHookData) -> None:
    """Deprecated alias — use ``process.hooks.deliver``."""
    await _callbacks.dispatch(str(process_id), data)


def clear_process_hook_callbacks(process_id: str | None = None) -> None:
    """Deprecated alias — use ``process.hooks.clear_callbacks``."""
    _callbacks.clear(process_id)


__all__ = [
    "SUPPORTED_PROCESS_HOOK_EVENTS",
    "ProcessHookCallback",
    "build_canonical_hook_data",
    "build_process_hook_snapshot",
    "clear_process_hook_callbacks",
    "dispatch_process_hook",
    "normalize_process_hook_events",
    "register_process_hook_callback",
]
