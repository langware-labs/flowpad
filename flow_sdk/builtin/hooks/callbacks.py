"""In-memory ``AgentHookCallback`` registry.

Callbacks are deliberately NOT persisted: hook *configuration* is durable (it
lives in the harness file or on the process row), but a Python callable belongs
to the process that registered it. Anything that must survive a restart is a
Trigger — that is what triggers are for.

Keyed by ``(target_key, event)`` where ``target_key`` is the process id for
Process scope and the provider name for the global scopes, and ``event`` may be
``None`` to mean "every event on this target". Keyed by identity string, never
by entity object: webhook delivery rehydrates a fresh entity every time.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from itertools import count
from threading import RLock
from typing import Optional

from flow_sdk.builtin.hooks.types import AgentHookResponse, HookEventType
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData

logger = logging.getLogger(__name__)

#: A hook callback. Returning ``None`` means "no opinion" — the common case for
#: an observer. Returning a response is only meaningful for a response-capable
#: event; see ``HookCapability.response_events``.
AgentHookCallback = Callable[
    [AgentHookData],
    "Awaitable[AgentHookResponse | None] | AgentHookResponse | None",
]

Unsubscribe = Callable[[], None]

_lock = RLock()
_next_token = count(1)
_callbacks: dict[tuple[str, Optional[str]], dict[int, AgentHookCallback]] = {}


def register(
    target_key: str,
    callback: AgentHookCallback,
    *,
    event: Optional[HookEventType] = None,
) -> Unsubscribe:
    """Register ``callback``; return an idempotent unsubscriber.

    Each registration is independent, including repeated registrations of the
    same callable.
    """
    if not callable(callback):
        raise TypeError("agent hook callback must be callable")
    key = (str(target_key), event.value if event else None)
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


def _snapshot(target_key: str, event: Optional[HookEventType]) -> tuple[AgentHookCallback, ...]:
    """Event-specific registrations first, then the catch-alls."""
    with _lock:
        specific = tuple((_callbacks.get((str(target_key), event.value if event else None)) or {}).values())
        catch_all = tuple((_callbacks.get((str(target_key), None)) or {}).values()) if event else ()
    return specific + catch_all


async def dispatch(
    target_key: str,
    data: AgentHookData,
    *,
    event: Optional[HookEventType] = None,
) -> AgentHookResponse | None:
    """Invoke every registration in order; return the FIRST non-None answer.

    Failures are isolated — one raising callback never stops the others. When two
    callbacks both answer, the first wins and the second is dropped with a
    warning: a silent merge of two decisions is worse than a visible conflict.
    """
    answer: AgentHookResponse | None = None
    for callback in _snapshot(target_key, event):
        try:
            result = callback(data)
            if inspect.isawaitable(result):
                result = await result
        except Exception:
            logger.exception("agent hook callback failed for %s", target_key)
            continue
        if result is None:
            continue
        if answer is None:
            answer = result
        else:
            logger.warning(
                "agent hook callback for %s returned a second answer (%s); keeping the first",
                target_key,
                type(result).__name__,
            )
    return answer


def clear(target_key: Optional[str] = None) -> None:
    """Clear one target's registrations, or every registration at shutdown."""
    with _lock:
        if target_key is None:
            _callbacks.clear()
            return
        for key in [k for k in _callbacks if k[0] == str(target_key)]:
            _callbacks.pop(key, None)
