"""System heartbeat — fires once per minute via a builtin SCHEDULE trigger.

Housekeeping tasks register via :func:`register_heartbeat_task`. The heartbeat
trigger has one CALLBACK action that fans out to all registered tasks on every
tick. Failure-isolated and time-bounded — one slow or raising task can't break
the others.

The trigger itself is installed by ``set_service_triggers()`` at server boot
(see ``flow_sdk/server/builtin_triggers.py``). Visible in ``/dock/triggers``
like any other system trigger; counter ticks each minute.

Contract for tasks:
  * Must be async and take no arguments.
  * Must be idempotent — a missed tick or double-run is harmless.
  * Should be O(small_set) — typical interactive load, not full-table walks.
  * Soft budget per task is :data:`TASK_TIMEOUT_SECONDS`; longer runs get
    cancelled with a warning.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from flow_sdk.builtin import trigger_callbacks

_log = logging.getLogger(__name__)


# Per-task soft budget. Bumpable if a real task needs more; the cap is a
# safety net so a runaway housekeeping job doesn't block the heartbeat.
TASK_TIMEOUT_SECONDS: float = 5.0


HeartbeatTask = Callable[[], Awaitable[None]]
_tasks: dict[str, HeartbeatTask] = {}


def register_heartbeat_task(name: str) -> Callable[[HeartbeatTask], HeartbeatTask]:
    """Decorator: register a coroutine to run once per heartbeat tick.

    Usage::

        @register_heartbeat_task("orphan_sweep")
        async def _cleanup() -> None:
            ...

    Re-registering the same name replaces the previous task — useful for
    hot-reload during development.
    """
    def deco(fn: HeartbeatTask) -> HeartbeatTask:
        _tasks[name] = fn
        return fn
    return deco


def list_registered() -> list[dict[str, Any]]:
    """Snapshot of currently-registered tasks. Useful for the debug UI."""
    return [{"name": name, "is_async": asyncio.iscoroutinefunction(fn)} for name, fn in _tasks.items()]


def _registered_tasks() -> dict[str, HeartbeatTask]:
    """Test hook — returns the internal registry. Don't mutate."""
    return _tasks


@trigger_callbacks.register(
    "builtin_heartbeat_dispatch",
    meaning="Fires every minute via the builtin_system_heartbeat SCHEDULE trigger. "
            "Iterates registered housekeeping tasks; failure isolation per task; "
            "per-task soft timeout of 5 s.",
)
async def _dispatch_heartbeat(_trigger: Any, _changes: Any) -> None:
    # Snapshot the task list — a task registering or unregistering mid-tick
    # (e.g. hot-reload during dev) must not affect this tick's iteration.
    for name, task in list(_tasks.items()):
        try:
            await asyncio.wait_for(task(), timeout=TASK_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            _log.warning(
                "heartbeat task %r exceeded %.1fs budget", name, TASK_TIMEOUT_SECONDS,
            )
        except Exception:
            _log.exception("heartbeat task %r raised", name)
