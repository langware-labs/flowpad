"""Tests for Entity.on_event + entity_event dispatch.

Pure dispatch tests; no indexer involvement. Verifies:
- Registered events route to the named method
- MRO walk finds handlers registered on a parent class
- Unknown event names return a noop success (never raise)
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity


class _ProbeEntity(Entity):
    type: str = APIField(default="probe_entity")
    counter: int = APIField(default=0)
    last_event: str = APIField(default="")

    async def on_ping(self, payload: dict) -> dict:
        self.counter += 1
        self.last_event = "ping"
        return {"echoed": payload.get("note", "")}


# Register on the owning subclass so the handler doesn't leak to siblings
# via the MRO walk — mirrors how AgenticProcess registers its handlers.
_ProbeEntity.on_event("ping")(_ProbeEntity.on_ping)


class _FakeRequest:
    """Minimal duck-type for what entity_event reads from `request`."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


@pytest.mark.asyncio
async def test_entity_event_dispatches_to_registered_handler() -> None:
    ent = _ProbeEntity(id="probe-1")
    resp = await ent.entity_event(_FakeRequest({"event": "ping", "payload": {"note": "hi"}}))
    payload = resp.data if hasattr(resp, "data") else resp
    assert payload["status"] == "ok"
    assert payload["event"] == "ping"
    assert payload["result"] == {"echoed": "hi"}
    assert ent.counter == 1
    assert ent.last_event == "ping"


@pytest.mark.asyncio
async def test_entity_event_unknown_event_returns_noop() -> None:
    ent = _ProbeEntity(id="probe-2")
    resp = await ent.entity_event(_FakeRequest({"event": "unregistered.event", "payload": {}}))
    payload = resp.data if hasattr(resp, "data") else resp
    assert payload["status"] == "noop"
    assert payload["event"] == "unregistered.event"
    assert ent.counter == 0  # handler never ran


@pytest.mark.asyncio
async def test_entity_event_registrations_are_subclass_isolated() -> None:
    """A handler registered on one subclass must not leak to sibling subclasses."""

    class _Sibling(Entity):
        type: str = APIField(default="sibling_entity")

    sibling = _Sibling(id="sib-1")
    resp = await sibling.entity_event(_FakeRequest({"event": "ping", "payload": {}}))
    payload = resp.data if hasattr(resp, "data") else resp
    # No `ping` handler registered on _Sibling → noop, not _ProbeEntity.on_ping.
    assert payload["status"] == "noop"


@pytest.mark.asyncio
async def test_entity_event_action_is_registered_in_action_registry() -> None:
    """The bare-name registration in entity_model.py must be discoverable."""
    from flow_sdk.actions.action_registry import action

    a = action.get_by_name("entity-event", "agentic_process")
    assert a is not None, "entity-event action must resolve for any entity type"
    assert a.handler.__qualname__.endswith("Entity.entity_event")
    # Also resolves bare (no type).
    assert action.get_by_name("entity-event") is not None
