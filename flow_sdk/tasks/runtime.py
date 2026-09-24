"""The task runtime on this machine: one subscriber to ``task.*`` that dispatches and delivers, the
bus-fed sources (the Tasks channel), and the stall watchdog. Started with the server."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_UNSUBSCRIBE: list = []
_INFLIGHT: set = set()
_WATCHDOG: list = []
#: How often the stall watchdog looks.
WATCH_EVERY_S = 60


async def on_task_event(data: dict) -> None:
    """The ledger's news, acted on: start a run, feed a run, free capacity, hold the budget."""
    from flow_sdk.builtin.task import Task  # noqa: PLC0415
    from flow_sdk.schema.data_spec.task_spec import TERMINAL_STATUSES  # noqa: PLC0415
    from flow_sdk.tasks import delivery, dispatch  # noqa: PLC0415

    task = await Task.get_by_id(str(data.get("task_id") or ""))
    if task is None:
        return
    event = str(data.get("event") or "")
    if event == "created":
        await dispatch.dispatch(task)
    await delivery.deliver(data)
    if task.status in {s.value for s in TERMINAL_STATUSES}:
        await dispatch.dispatch_waiting(task.creator or "")
    elif data.get("author") == task.owner:
        await dispatch.check_budget(task)


def start(*, watchdog: bool = True) -> None:
    """Idempotent."""
    if _UNSUBSCRIBE:
        return
    from flow_sdk.ingest import bus_sources  # noqa: PLC0415
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    async def _on(event) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        task = create_detached_task(_safely(dict(event.data or {})), name="task-runtime")
        _INFLIGHT.add(task)
        task.add_done_callback(_INFLIGHT.discard)

    _UNSUBSCRIBE.append(on_tag("task.*", _on))
    bus_sources.start()
    if watchdog:
        _WATCHDOG.append(asyncio.get_running_loop().create_task(_watch(), name="task-stall-watchdog"))


def stop() -> None:
    from flow_sdk.ingest import bus_sources  # noqa: PLC0415

    while _UNSUBSCRIBE:
        _UNSUBSCRIBE.pop()()
    while _WATCHDOG:
        _WATCHDOG.pop().cancel()
    bus_sources.stop()


async def settle() -> None:
    """Wait until the runtime and the Tasks channel have acted on everything in flight."""
    from flow_sdk.ingest import bus_sources  # noqa: PLC0415

    while _INFLIGHT or bus_sources._INFLIGHT:  # noqa: SLF001
        await asyncio.gather(*list(_INFLIGHT), return_exceptions=True)
        await bus_sources.settle()


async def _safely(data: dict) -> None:
    try:
        await on_task_event(data)
    except Exception:  # noqa: BLE001 — one task's trouble must not stop the next
        logger.exception("[tasks] acting on %s of %s failed", data.get("event"), data.get("task_id"))


async def _watch() -> None:
    from flow_sdk.tasks.dispatch import check_stalls  # noqa: PLC0415

    while True:
        await asyncio.sleep(WATCH_EVERY_S)
        try:
            await check_stalls()
        except Exception:  # noqa: BLE001
            logger.exception("[tasks] stall check failed")


__all__ = ["on_task_event", "settle", "start", "stop"]
