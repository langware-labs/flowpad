"""In-process handler registry for Trigger CALLBACK actions.

Consumers register named Python handlers at module init time:

    @trigger_callbacks.register("toplog_config_changed", meaning="reload toplog state")
    async def _on_change(trigger, changes: list[ChangeEvent]):
        ...

A Trigger with `action_type=CALLBACK` and `callback_name="toplog_config_changed"`
will then dispatch its fires to this handler via `CallbackActionHandler`.

Re-registration replaces the previous handler. `list_registered()` powers the
UI's callback-name autocomplete dropdown (admin endpoint at /api/v1/debug/trigger_callbacks).
"""
from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass
class _Entry:
    fn: Callable[..., Any]
    meaning: Optional[str]
    is_async: bool


_handlers: dict[str, _Entry] = {}


def register(name: str, meaning: Optional[str] = None):
    """Decorator. Stash a handler under `name` so a CALLBACK action can dispatch to it.

    Returns the original function untouched so the registered handler can also be
    called directly by Python code (useful for tests and direct invocation).
    """

    def _decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        _handlers[name] = _Entry(fn=fn, meaning=meaning, is_async=inspect.iscoroutinefunction(fn))
        return fn

    return _decorator


def get(name: str) -> Optional[Callable[..., Any]]:
    """Look up a handler by name. Returns None if not registered."""
    entry = _handlers.get(name)
    return entry.fn if entry else None


def list_registered() -> list[dict[str, Any]]:
    """Snapshot of registered handlers — feeds the UI autocomplete dropdown."""
    return [
        {"name": name, "meaning": entry.meaning, "is_async": entry.is_async}
        for name, entry in _handlers.items()
    ]
