"""Shared contracts and callback delivery for process-scoped worker hooks.

The registry is keyed by entity identity, not ``AgenticProcess`` object
identity: webhook delivery normally rehydrates a fresh entity instance. Hook
configuration is persisted on the entity; Python callbacks intentionally are
not.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable, Sequence
from itertools import count
from threading import RLock
from typing import Any

from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData

logger = logging.getLogger(__name__)

ProcessHookCallback = Callable[[AgentHookData], Awaitable[None] | None]

_lock = RLock()
_next_token = count(1)
_callbacks: dict[str, dict[int, ProcessHookCallback]] = {}
SUPPORTED_PROCESS_HOOK_EVENTS = frozenset(
    {
        HookEventType.SESSION_START,
        HookEventType.SESSION_END,
        HookEventType.USER_PROMPT_SUBMIT,
    }
)


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
        "schema": 1,
    }


def register_process_hook_callback(
    process_id: str,
    callback: ProcessHookCallback,
) -> Callable[[], None]:
    """Register ``callback`` for every hook on ``process_id``.

    Each registration is independent, including repeated registrations of the
    same callable. The returned synchronous unsubscriber removes exactly this
    registration and is safe to call repeatedly.
    """
    if not callable(callback):
        raise TypeError("process hook callback must be callable")
    key = str(process_id)
    token = next(_next_token)
    with _lock:
        _callbacks.setdefault(key, {})[token] = callback

    def unsubscribe() -> None:
        with _lock:
            registrations = _callbacks.get(key)
            if registrations is None:
                return
            registrations.pop(token, None)
            if not registrations:
                _callbacks.pop(key, None)

    return unsubscribe


async def dispatch_process_hook(process_id: str, data: AgentHookData) -> None:
    """Invoke a stable registration-order snapshot, isolating failures."""
    with _lock:
        callbacks = tuple((_callbacks.get(str(process_id)) or {}).values())
    for callback in callbacks:
        try:
            result = callback(data)
            if inspect.isawaitable(result):
                await result
        except Exception:
            logger.exception("process hook callback failed for %s", process_id)


def clear_process_hook_callbacks(process_id: str | None = None) -> None:
    """Clear one process's subscriptions, or every subscription at shutdown."""
    with _lock:
        if process_id is None:
            _callbacks.clear()
        else:
            _callbacks.pop(str(process_id), None)


__all__ = [
    "SUPPORTED_PROCESS_HOOK_EVENTS",
    "ProcessHookCallback",
    "build_process_hook_snapshot",
    "clear_process_hook_callbacks",
    "dispatch_process_hook",
    "normalize_process_hook_events",
    "register_process_hook_callback",
]
