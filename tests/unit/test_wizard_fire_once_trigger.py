"""``Trigger.fire_once`` — "once per machine, ever", kept where the durable
counter already is.

The alternative was a bespoke claim file beside whoever emits the event, gating
ONE event for ONE feature. Putting it on the trigger instead means the emitter
needs no gate at all: an ordinary lifecycle event fires on every boot, and a
subscriber that wants only the first one says so itself. That is also the reason
a wizard's declared trigger is a ROW — an in-memory subscription has nowhere to
keep a counter across a restart.
"""
import asyncio

import pytest

from flow_sdk.builtin.tag_triggers import register_tag_trigger, unregister_tag_trigger
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.tags import emit_tag, target_of
from tests.conftest import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_MAX_DRAIN_ROUNDS = 50


async def _settle():
    """Await the tasks the bus scheduled rather than sleeping a fixed budget —
    the idiom the other tag suites use, and for their stated reason: emit never
    awaits consumers, so a fixed sleep lands the handler inside the NEXT test."""
    current = asyncio.current_task()
    for _ in range(_MAX_DRAIN_ROUNDS):
        pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)
    raise AssertionError("tag handlers never went quiet")


def _trigger(**kw) -> Trigger:
    defaults = dict(name="t-once", trigger_type=TriggerType.TAG,
                    tag_pattern="wzonce.ready", scope="system")
    defaults.update(kw)
    return Trigger(**defaults)


@async_context
async def test_default_is_off_so_existing_triggers_are_unaffected():
    assert _trigger().fire_once is False


@async_context
async def test_a_fire_once_trigger_answers_the_first_event_only():
    trigger = _trigger(tag_pattern="wzonce.a", fire_once=True)
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("wzonce.a", target_of("compute_node", "n-1"))
        await _settle()
        first = await Trigger.get_by_id(trigger.id)
        assert first.counter == 1

        emit_tag("wzonce.a", target_of("compute_node", "n-1"))
        emit_tag("wzonce.a", target_of("compute_node", "n-1"))
        await _settle()
        again = await Trigger.get_by_id(trigger.id)
        assert again.counter == 1, "a spent fire-once trigger must not fire again"
        assert again.last_run == first.last_run
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_without_fire_once_every_event_still_fires():
    trigger = _trigger(tag_pattern="wzonce.b", fire_once=False)
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("wzonce.b", target_of("compute_node", "n-1"))
        await _settle()
        emit_tag("wzonce.b", target_of("compute_node", "n-1"))
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 2
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_the_spend_survives_a_re_arm():
    """A restart re-arms every TAG trigger from the DB. The counter is what
    stops that from re-running the wizard on every boot."""
    trigger = _trigger(tag_pattern="wzonce.c", fire_once=True)
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("wzonce.c", target_of("compute_node", "n-1"))
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1

        # Simulate the boot sweep: re-arm from the persisted row.
        unregister_tag_trigger(trigger.id)
        register_tag_trigger(await Trigger.get_by_id(trigger.id))

        emit_tag("wzonce.c", target_of("compute_node", "n-1"))
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_a_spent_trigger_is_suppressed_not_deleted():
    """It stays visible in the Triggers screen, showing that it ran — 'the rule
    is armed, the event matched, and nothing happened' is the single most
    confusing silent non-fire in the design."""
    trigger = _trigger(tag_pattern="wzonce.d", fire_once=True)
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("wzonce.d", target_of("compute_node", "n-1"))
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row is not None and row.enabled is True
        assert row.last_run is not None
    finally:
        unregister_tag_trigger(trigger.id)
