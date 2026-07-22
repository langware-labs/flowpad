"""Phase 4 — TOPIC triggers: Trigger entities as unified-bus subscriptions."""
import asyncio

from flow_sdk.builtin import topic_triggers
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.topic_triggers import (
    register_topic_trigger,
    unregister_topic_trigger,
    validate_topic_trigger,
)
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.topics import emit_topic, target_of
from tests.conftest import async_context


async def _settle():
    # topic handlers are scheduled as loop tasks (law 3) — let them land.
    for _ in range(20):
        await asyncio.sleep(0.01)


def _topic_trigger(**kw) -> Trigger:
    defaults = dict(name="t-topic", trigger_type=TriggerType.TOPIC,
                    topic_pattern="entity.created", scope="system")
    defaults.update(kw)
    return Trigger(**defaults)


def test_validate_topic_trigger():
    assert validate_topic_trigger(None)
    assert validate_topic_trigger("  ")
    assert "EVERY event" in validate_topic_trigger("*")
    assert validate_topic_trigger("entity.*") is None


@async_context
async def test_topic_trigger_fires_on_matching_event(tmp_path):
    trigger = _topic_trigger(topic_pattern="drill.*", topic_target="usage_report:*")
    await trigger.save()
    register_topic_trigger(trigger)
    try:
        emit_topic("drill.ping", target_of("usage_report", "r-1"))
        emit_topic("drill.ping", target_of("task", "t-1"))       # target-filtered out
        emit_topic("other.ping", target_of("usage_report", "r-2"))  # pattern-filtered out
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 1
        assert row.last_run is not None
    finally:
        unregister_topic_trigger(trigger.id)


@async_context
async def test_disabled_and_reregister_semantics(tmp_path):
    trigger = _topic_trigger(topic_pattern="rr.*")
    await trigger.save()
    register_topic_trigger(trigger)
    register_topic_trigger(trigger)  # re-arm REPLACES — no double subscription
    try:
        emit_topic("rr.one", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1

        # Reload before mutating — updating the stale pre-fire instance would
        # clobber the counter the fire just wrote.
        row = await Trigger.get_by_id(trigger.id)
        row.enabled = False
        await row.update()
        register_topic_trigger(row)  # disabled → unsubscribed
        emit_topic("rr.two", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1
    finally:
        unregister_topic_trigger(trigger.id)


@async_context
async def test_storm_guard_caps_and_logs_once(tmp_path, monkeypatch):
    logged: list[dict] = []
    monkeypatch.setattr(topic_triggers, "_append_log",
                        lambda name, entry: logged.append(entry))
    trigger = _topic_trigger(topic_pattern="storm.*", max_fires_per_minute=3)
    await trigger.save()
    register_topic_trigger(trigger)
    try:
        for i in range(8):
            emit_topic("storm.hit", f"x:{i}")
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 3  # capped
        suppressed = [e for e in logged if e.get("hook_event") == "storm_suppressed"]
        assert len(suppressed) == 1  # one per window, never silent
    finally:
        unregister_topic_trigger(trigger.id)


@async_context
async def test_confirm_gate_consults_the_store(tmp_path):
    from flow_sdk.builtin.usage_report import UsageReport

    trigger = _topic_trigger(
        topic_pattern="confirm.*",
        confirm={"type": "usage_report", "filter": {"name": "confirm-proof"}})
    await trigger.save()
    register_topic_trigger(trigger)
    try:
        emit_topic("confirm.check", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 0  # store says no

        report = UsageReport(name="confirm-proof", period="day")
        await report.save()
        emit_topic("confirm.check", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1  # store says yes
    finally:
        unregister_topic_trigger(trigger.id)


@async_context
async def test_entity_created_fires_topic_trigger_end_to_end(tmp_path):
    """The phase-3 acceptance completed: a UsageReport.save() (entity emitter)
    fires a TOPIC trigger — no synthetic emit involved."""
    from flow_sdk.builtin.usage_report import UsageReport

    trigger = _topic_trigger(topic_pattern="entity.created",
                             topic_target="usage_report:*",
                             actions=[TriggerAction(action_type=ActionType.NOP)])
    await trigger.save()
    register_topic_trigger(trigger)
    try:
        report = UsageReport(name="e2e-fire", period="day")
        await report.save()
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 1
    finally:
        unregister_topic_trigger(trigger.id)
