"""System heartbeat — fires once per minute via a builtin SCHEDULE trigger.

Housekeeping tasks register via :func:`register_heartbeat_task`. The heartbeat
trigger has one CALLBACK action that fans out to all registered tasks on every
tick. Failure-isolated and time-bounded — one slow or raising task can't break
the others.

The trigger itself is installed by ``set_service_triggers()`` at server boot
(see ``flow_sdk/server/builtin_triggers.py``). Visible in ``/dock/automations``
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
    _start_watchdog()  # TEMP-PERF
    for name, task in list(_tasks.items()):
        import time as _t  # TEMP-PERF
        _w0, _c0 = _t.perf_counter(), _t.thread_time()
        try:
            await asyncio.wait_for(task(), timeout=TASK_TIMEOUT_SECONDS)
            _log.warning("TEMP-PERF heartbeat %s wall=%.2fs loop-cpu=%.2fs", name, _t.perf_counter() - _w0, _t.thread_time() - _c0)
        except asyncio.TimeoutError:
            _log.warning(
                "heartbeat task %r exceeded %.1fs budget", name, TASK_TIMEOUT_SECONDS,
            )
        except Exception:
            _log.exception("heartbeat task %r raised", name)


# TEMP-PERF watchdog: when the event loop stalls > 1 s, log what the main thread is running.
import sys as _sys  # noqa: E402
import threading as _th  # noqa: E402
import time as _tm  # noqa: E402
import traceback as _tb  # noqa: E402

_beat = {"t": _tm.monotonic(), "tid": None, "started": False}


async def _ticker() -> None:
    _beat["tid"] = _th.get_ident()
    while True:
        _beat["t"] = _tm.monotonic()
        await asyncio.sleep(0.1)


def _watch() -> None:
    reported = 0.0
    while True:
        _tm.sleep(0.25)
        lag = _tm.monotonic() - _beat["t"]
        if lag > 1.0 and _beat["tid"] and _tm.monotonic() - reported > 0.9:
            frame = _sys._current_frames().get(_beat["tid"])
            if frame is not None:
                _log.warning("TEMP-PERF loop stalled %.1fs:\n%s", lag, "".join(_tb.format_stack(frame)[-25:]))
                reported = _tm.monotonic()


def _start_watchdog() -> None:
    if _beat["started"]:
        return
    _beat["started"] = True
    asyncio.get_running_loop().create_task(_ticker())
    _th.Thread(target=_watch, daemon=True, name="temp-perf-watchdog").start()
