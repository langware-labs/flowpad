"""The event bus as a map: event types, counts, who listens, what they do."""

from __future__ import annotations

import pytest

from flow_sdk.automations.bus_map import bus_map
from flow_sdk.schema.data_spec.trigger_types import TriggerType
from flow_sdk.tags import emit_tag
from tests.pytest_plugin import async_context
from tests.unit.automations._helpers import rule

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _by_name(m):
    return {e.name: e for e in m.event_types}


@async_context
async def test_catalog_events_carry_their_titles_and_listeners():
    trigger = rule(TriggerType.TAG, tag_pattern="app.ready")
    await trigger.save()
    events = _by_name(await bus_map())
    ready = events["app.ready"]
    assert ready.title and any(lst.id == trigger.id for lst in ready.listeners)
    assert ready.forwarded is True
    assert events["app"].family is True and events["app"].listeners == []


@async_context
async def test_observed_tags_count_and_a_wildcard_listener_matches_them():
    trigger = rule(TriggerType.TAG, tag_pattern="busmapx.*")
    await trigger.save()
    emit_tag("busmapx.ping", "task:1")
    emit_tag("busmapx.ping", "task:2")
    ping = _by_name(await bus_map())["busmapx.ping"]
    assert ping.count >= 2 and ping.last_target == "task:2"
    assert [lst.id for lst in ping.listeners] == [trigger.id]


@async_context
async def test_a_pattern_nothing_has_matched_is_still_shown():
    trigger = rule(TriggerType.TAG, tag_pattern="neverseen.thing")
    await trigger.save()
    entry = _by_name(await bus_map())["neverseen.thing"]
    assert entry.pattern_only and entry.listeners[0].id == trigger.id
