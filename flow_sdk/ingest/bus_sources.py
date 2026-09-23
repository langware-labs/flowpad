"""Sources fed by the event bus — an internal event stream as a channel.

A source whose records are OUR OWN events (a task ledger, a run log) has no provider to poll and no
webhook to receive: it declares the bus topics it listens to (``bus_topics = ("task.*",)``) and turns
each matching event into items (``events_from_bus(tag, data) -> list[DataSourceEvent]``). This module
subscribes those topics once and hands every matching event to every ACTIVE source of such a driver,
through the same ingestion chokepoint a webhook uses (``DriverRuntime.ingest_events``) — so the items
land, project into threads and reach a serve loop exactly like any channel's.

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
            _UNSUBSCRIBE.append(on_tag(pattern, _handler_for(driver.provider)))


def stop() -> None:
    while _UNSUBSCRIBE:
        _UNSUBSCRIBE.pop()()


def _handler_for(provider: str):
    async def _on_event(event) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        # Detached: a tag fires inside its writer's commit, whose session this must not join.
        task = create_detached_task(deliver(provider, event.tag, dict(event.data or {})), name=f"bus-source:{provider}")
        _INFLIGHT.add(task)
        task.add_done_callback(_INFLIGHT.discard)

    return _on_event


async def deliver(provider: str, tag: str, data: dict[str, Any]) -> int:
    """One bus event to every active source of ``provider``. Returns how many items were ingested."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415

    driver = DataDriver.loaded(provider)
    if driver is None:
        return 0
    ingested = 0
    for row in await DataSource.get_all({"provider": provider}) or []:
        if str(getattr(row, "status", "") or "") != SourceStatus.ACTIVE.value:
            continue
        try:
            source = await driver.open(row)
            async with source:
                events = source.events_from_bus(tag, data)  # type: ignore[attr-defined]
            if events:
                result = await driver.ingest_events(row, events)
                ingested += int(result.get("ingested") or 0)
        except Exception:  # noqa: BLE001 — one source's failure must not starve the others
            logger.exception("[bus-source] %s: %s on %s failed", provider, tag, getattr(row, "id", "?"))
    return ingested


async def settle() -> None:
    """Wait for every delivery in flight — a test's (or a shutdown's) barrier."""
    while _INFLIGHT:
        await asyncio.gather(*list(_INFLIGHT), return_exceptions=True)


__all__ = ["bus_fed_drivers", "deliver", "principal_channel_for", "settle", "start", "stop"]
