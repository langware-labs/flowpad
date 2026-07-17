"""FlowFunction registry — the flow system's built-in function library.

A **FlowFunction** is a named Python function with the one flow contract:

    @flow_functions.register("publish_report", meaning="post a report to the feed")
    async def on_flow_event(event_name: str, data: dict, flow_ctx) -> dict | None:
        ...

A ``function`` node references it by registry name (``runtime: inline`` — runs
on the server event loop with direct SDK access) or promotes it to isolation
(``runtime: subprocess`` — the function_runner imports flow_sdk and resolves
the same name). Flow-folder scripts (``scripts/*.py``) implement the SAME
contract but only ever run in a subprocess — flow-folder code never runs in
the server process.

Contract notes:
* ``flow_ctx`` carries ``input_folder`` / ``output_folder`` (THIS execution's
  record) and ``flow_output_folder`` (the run's output), plus
  ``emit_flow_event(key, val)`` and ``post(path, body)``.
* A non-None **dict return auto-emits** the node's ``done`` event with it —
  identical in both runtimes; use ``emit_flow_event`` for anything more.
* **Inline functions run on the server event loop**: they must be fast and
  async-friendly (await your I/O; never block on CPU). Heavy work belongs in
  ``runtime: subprocess``.

Separate from ``flow_sdk.builtin.trigger_callbacks`` on purpose: that registry
holds TRIGGER-signature handlers ``fn(trigger, changes)``; this one holds the
flow contract. One namespace per signature — no runtime surprises.
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


_functions: dict[str, _Entry] = {}


def register(name: str, meaning: Optional[str] = None):
    """Decorator: register a FlowFunction under ``name`` (re-registration replaces)."""

    def _decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        _functions[name] = _Entry(fn=fn, meaning=meaning, is_async=inspect.iscoroutinefunction(fn))
        return fn

    return _decorator


def get(name: str) -> Optional[Callable[..., Any]]:
    """Look up a FlowFunction by name. Returns None if not registered."""
    entry = _functions.get(name)
    return entry.fn if entry else None


def list_registered() -> list[dict[str, Any]]:
    """Snapshot for the UI's Function picker (name + meaning)."""
    return [
        {"name": name, "meaning": entry.meaning, "is_async": entry.is_async}
        for name, entry in sorted(_functions.items())
    ]
