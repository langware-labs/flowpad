"""Generic hub event types — the wire shape that ``HubWsBridge`` fans out
to ``Entity.cloud_watch()`` subscribers.

Mirrors the hub's ``DataOpMessage`` envelope (``flowpad/hub/api/messages.py``)
in a Pythonic dataclass.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional


EntityOp = Literal["create", "update", "delete"]


@dataclass(frozen=True)
class EntityEvent:
    """A single hub event scoped to one entity."""

    op: EntityOp
    entity_type: str
    entity_id: str
    parent_type: Optional[str] = None
    parent_id: Optional[str] = None
    data: dict = field(default_factory=dict)


class CloudWatch:
    """Async-context buffer over hub events scoped to a single entity.

    Returned by ``Entity.cloud_watch()``. Inside the context the watcher is
    subscribed to ``hub_ws_bridge`` with ``scope_id = entity.id`` — matching
    both UPDATEs to the entity itself *and* CREATE/UPDATE/DELETE on its
    children. Outside the context the subscription is torn down.

    Usage::

        async with conv.cloud_watch() as stream:
            async for event in stream:
                if event.entity_type == "flow_message" and event.op == "create":
                    print(event.data["text"])

        # or, for tests:
        async with conv.cloud_watch() as stream:
            ev = await stream.next_where(
                lambda e: e.entity_type == "flow_message"
                          and e.data.get("text") == "Received: m0",
                timeout=2.0,
            )
    """

    def __init__(self, scope_id: str):
        self._scope_id = scope_id
        self._queue: asyncio.Queue[EntityEvent] = asyncio.Queue()
        self._unsub: Optional[Callable[[], None]] = None

    async def __aenter__(self) -> "CloudWatch":
        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

        self._unsub = hub_ws_bridge.subscribe(
            self._queue.put_nowait,
            scope_id=self._scope_id,
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    def __aiter__(self) -> "CloudWatch":
        return self

    async def __anext__(self) -> EntityEvent:
        return await self._queue.get()

    async def next_where(
        self,
        predicate: Callable[[EntityEvent], bool],
        *,
        timeout: float = 2.0,
    ) -> EntityEvent:
        """Drain events until ``predicate(event)`` is truthy, then return it.

        Raises ``asyncio.TimeoutError`` if no event matches within ``timeout``.
        """

        async def _find() -> EntityEvent:
            async for ev in self:
                if predicate(ev):
                    return ev
            raise RuntimeError("CloudWatch stream exhausted before match")

        return await asyncio.wait_for(_find(), timeout=timeout)
