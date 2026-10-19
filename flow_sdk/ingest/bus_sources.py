"""Sources nudged by the event bus — "pull now" for a source whose records are our own.

A source over OUR OWN rows (tasks and their comments) is pulled like any other: it lists what it
carries and the sync engine reads it on its cadence. The bus only makes that immediate: the source
declares the topics that can change its listing (``bus_topics = ("task.*", "entity.*")``) and which
events on them matter (``wants(tag, data)``), and this module polls every ACTIVE source of such a
driver NOW (``poller.poll_source``) — the same pass a heartbeat would run, so the items land, project
into threads and reach a serve loop exactly like any channel's. A lost event is latency, never loss.

It knows no driver: which drivers are bus-fed, and on which topics, the driver classes say.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

_UNSUBSCRIBE: list = []
_INFLIGHT: set = set()


def bus_fed_drivers() -> list:
    """Every loaded driver whose source class declares bus topics."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    return [driver for _key, driver in DRIVERS.items() if getattr(driver.cls, "bus_topics", ())]


def principal_channel_for(topic: str):
    """The bus-fed driver that carries ``topic``'s events as one channel per principal
    (``principal_channel = True``), or ``None``. How machinery finds "the Tasks channel" without a name."""
    from fnmatch import fnmatchcase  # noqa: PLC0415

    for driver in bus_fed_drivers():
        if getattr(driver.cls, "principal_channel", False) and any(fnmatchcase(topic, p) for p in driver.cls.bus_topics):
            return driver
    return None


def start() -> None:
    """Subscribe each bus-fed driver's topics. Idempotent."""
    if _UNSUBSCRIBE:
        return
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    for driver in bus_fed_drivers():
        for pattern in driver.cls.bus_topics:
            _UNSUBSCRIBE.append(on_tag(pattern, _handler_for(driver.provider, getattr(driver.cls, "wants", None))))


def stop() -> None:
    while _UNSUBSCRIBE:
        _UNSUBSCRIBE.pop()()


def _handler_for(provider: str, wants=None):
    def _on_event(event) -> None:
        # Sync on purpose: the bus calls a sync handler inside ``emit``, i.e. inside the writer's own
        # transaction — so the pull can wait for that commit. Nudged earlier, it reads the row as it was
        # before the write and lists nothing new until some later write nudges it again.
        data = dict(event.data or {})
        # Asked before anything is spawned: a broad topic (``entity.*``) fires on every write.
        if wants is not None and not wants(event.tag, data):
            return

        from flow_sdk.request_context.detached import add_detached_done_callback, create_detached_task  # noqa: PLC0415

        async def pull() -> None:
            # Detached: its own session, never the writer's.
            task = create_detached_task(deliver(provider, event.tag, data), name=f"bus-source:{provider}")
            _INFLIGHT.add(task)
            add_detached_done_callback(task, _INFLIGHT.discard)

        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        # Queued on the writer's transaction right here, inside ``emit``; with none bound the write is durable.
        if not get_db_driver().defer_to_commit(pull):
            registering = create_detached_task(pull(), name=f"bus-source:{provider}:register")
            _INFLIGHT.add(registering)
            add_detached_done_callback(registering, _INFLIGHT.discard)

    return _on_event


async def deliver(provider: str, tag: str, data: dict[str, Any]) -> int:
    """One bus event (already one the driver ``wants``): poll every active source of ``provider`` now.
    Returns how many sources were polled."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
    from flow_sdk.ingest.poller import poll_source  # noqa: PLC0415

    if DataDriver.loaded(provider) is None:
        return 0
    polled = 0
    for row in await DataSource.get_all({"provider": provider}) or []:
        if str(getattr(row, "status", "") or "") != SourceStatus.ACTIVE.value:
            continue
        try:
            await poll_source(row, follow_up=True)
            polled += 1
        except Exception:  # noqa: BLE001 — one source's failure must not starve the others
            logger.exception("[bus-source] %s: %s on %s failed", provider, tag, getattr(row, "id", "?"))
    return polled


async def settle() -> None:
    """Wait for every delivery in flight — a test's (or a shutdown's) barrier."""
    while _INFLIGHT:
        await asyncio.gather(*list(_INFLIGHT), return_exceptions=True)


__all__ = ["bus_fed_drivers", "deliver", "principal_channel_for", "settle", "start", "stop"]
