"""Phase 4 — TAG triggers: Trigger entities as unified-bus subscriptions."""
import asyncio

from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.tag_triggers import (
    register_tag_trigger,
    unregister_tag_trigger,
    validate_tag_trigger,
)
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.tags import emit_tag, target_of
from tests.conftest import async_context


async def _settle():
    # tag handlers are scheduled as loop tasks (law 3) — let them land.
    for _ in range(20):
        await asyncio.sleep(0.01)


def _tag_trigger(**kw) -> Trigger:
    defaults = dict(name="t-tag", trigger_type=TriggerType.TAG,
                    tag_pattern="entity.created", scope="system")
    defaults.update(kw)
    return Trigger(**defaults)


def test_validate_tag_trigger():
    assert validate_tag_trigger(None)
    assert validate_tag_trigger("  ")
    assert "EVERY event" in validate_tag_trigger("*")
    assert validate_tag_trigger("entity.*") is None


@async_context
async def test_tag_trigger_fires_on_matching_event(tmp_path):
    trigger = _tag_trigger(tag_pattern="drill.*", tag_target="usage_report:*")
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("drill.ping", target_of("usage_report", "r-1"))
        emit_tag("drill.ping", target_of("task", "t-1"))       # target-filtered out
        emit_tag("other.ping", target_of("usage_report", "r-2"))  # pattern-filtered out
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 1
        assert row.last_run is not None
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_disabled_and_reregister_semantics(tmp_path):
    trigger = _tag_trigger(tag_pattern="rr.*")
    await trigger.save()
    register_tag_trigger(trigger)
    register_tag_trigger(trigger)  # re-arm REPLACES — no double subscription
    try:
        emit_tag("rr.one", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1

        # Reload before mutating — updating the stale pre-fire instance would
        # clobber the counter the fire just wrote.
        row = await Trigger.get_by_id(trigger.id)
        row.enabled = False
        await row.update()
        register_tag_trigger(row)  # disabled → unsubscribed
        emit_tag("rr.two", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_storm_guard_caps_and_logs_once(tmp_path, monkeypatch):
    logged: list[dict] = []
    monkeypatch.setattr(tag_triggers, "_append_log",
                        lambda name, entry: logged.append(entry))
    trigger = _tag_trigger(tag_pattern="storm.*", max_fires_per_minute=3)
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        for i in range(8):
            emit_tag("storm.hit", f"x:{i}")
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 3  # capped
        suppressed = [e for e in logged if e.get("hook_event") == "storm_suppressed"]
        assert len(suppressed) == 1  # one per window, never silent
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_confirm_gate_consults_the_store(tmp_path):
    from flow_sdk.builtin.usage_report import UsageReport

    trigger = _tag_trigger(
        tag_pattern="confirm.*",
        confirm={"type": "usage_report", "filter": {"name": "confirm-proof"}})
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        emit_tag("confirm.check", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 0  # store says no

        report = UsageReport(name="confirm-proof", period="day")
        await report.save()
        emit_tag("confirm.check", "x:1")
        await _settle()
        assert (await Trigger.get_by_id(trigger.id)).counter == 1  # store says yes
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_entity_created_fires_tag_trigger_end_to_end(tmp_path):
    """The phase-3 acceptance completed: a UsageReport.save() (entity emitter)
    fires a TAG trigger — no synthetic emit involved."""
    from flow_sdk.builtin.usage_report import UsageReport

    trigger = _tag_trigger(tag_pattern="entity.created",
                             tag_target="usage_report:*",
                             actions=[TriggerAction(action_type=ActionType.NOP)])
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        report = UsageReport(name="e2e-fire", period="day")
        await report.save()
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 1
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_tag_trigger_preserves_envelope_identity_on_flow_entry(tmp_path):
    """Phase 7 post-review: the TAG-trigger door preserves the triggering
    envelope's id + actor onto the flow entry, matching the subscription door."""
    import json as _json

    from flow_sdk.builtin.graph_workflow import GraphWorkflow
    from flow_sdk.graph_workflow_manager import (
        get_graph_workflow_manager,
        graph_workflow_functions,
    )
    from flow_sdk.graph_workflow_manager.journal import read_run_journal
    from flow_sdk.tags import FlowEvent, event_bus

    @graph_workflow_functions.register("v2_trig_prov")
    def _p(event_name, data, ctx):
        return {}

    flow = GraphWorkflow(name="trigprov", asset_ref=str(tmp_path / "trigprov"))
    await flow.save()
    trigger = _tag_trigger(tag_pattern="tp.*")
    await trigger.save()
    (tmp_path / "trigprov" / "graph.json").write_text(_json.dumps({
        "version": 1, "id": flow.id, "name": "trigprov", "enabled": True,
        "nodes": [
            {"id": "t", "node_type": "trigger",
             "node_data": {"typeid": f"trigger-{trigger.id}"}},
            {"id": "a", "node_type": "function", "node_data": {"function": "v2_trig_prov"}},
        ],
        "edges": [{"id": "e", "from": {"node": "t", "event": "fired"}, "to": {"node": "a"}}],
    }))
    register_tag_trigger(trigger)
    try:
        env = FlowEvent(tag="tp.fire", target="x:1",
                        ctx={"origin": "local_server", "actor": "user:u-7"})
        event_bus.deliver(env)
        fm = get_graph_workflow_manager()
        await _settle()
        runs = fm.live_run_ids()
        for _ in range(100):
            if not fm.live_run_ids():
                break
            await asyncio.sleep(0.01)
        entries = read_run_journal(tmp_path / "trigprov",
                                   (await __import__("flow_sdk.builtin.graph_workflow_run",
                                    fromlist=["GraphWorkflowRun"]).GraphWorkflowRun.get_all(
                                        {"flow_id": flow.id}))[0].id)
        row = next(e for e in entries if e["kind"] == "event")
        assert row["event_id"] == env.id
        assert row["actor"] == "user:u-7"
    finally:
        unregister_tag_trigger(trigger.id)


# ── bus emission + the self-loop brake (trigger → event) ────────────────────


@async_context
async def test_tag_fire_emits_trigger_fired_with_cause(tmp_path):
    """The fire is a NEW fact caused by an envelope: fresh id, cause_event_id
    pointing back, actor relayed. Falsifiable — passing the cause id through
    instead of minting breaks the first assertion."""
    from flow_sdk.tags import event_bus, make_tag_event

    trigger = _tag_trigger(tag_pattern="cz.*")
    await trigger.save()
    register_tag_trigger(trigger)
    fired = []
    unsub = event_bus.on("trigger.fired", fired.append)
    try:
        cause = make_tag_event("cz.go", target_of("usage_report", "r-1"), {},
                               {"actor": "user:u-42"})
        event_bus.publish(cause)
        await _settle()
        assert len(fired) == 1
        ev = fired[0]
        assert ev.id != cause.id
        assert ev.data["cause_event_id"] == cause.id
        assert ev.target == target_of("trigger", trigger.id)
        assert ev.ctx.actor == "user:u-42"
        assert ev.ctx.scope[0] == target_of("trigger", trigger.id)
    finally:
        unsub()
        unregister_tag_trigger(trigger.id)


@async_context
async def test_self_loop_brake_stops_a_trigger_firing_itself(tmp_path):
    """`trigger.*` is a pattern a user can save today. Once trigger.fired
    exists, a rule subscribed to it feeds itself forever.

    THE falsification test for this slice: delete the brake in
    _fire_tag_trigger_locked and the counter climbs to the storm cap (30)
    instead of 1 — proving the storm guard is containment, not correctness.
    """
    trigger = _tag_trigger(tag_pattern="trigger.*")
    await trigger.save()
    register_tag_trigger(trigger)
    try:
        # One external kick with no trigger in scope: legal, fires once.
        emit_tag("trigger.fired", target_of("trigger", "other"), {},
                 {"scope": [target_of("trigger", "other")]})
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 1, "one external event, one fire — not a cascade"
    finally:
        unregister_tag_trigger(trigger.id)


@async_context
async def test_two_tag_triggers_cannot_ping_pong(tmp_path):
    """A→B→A CONVERGES instead of running forever, and does so via scope
    propagation rather than the storm cap.

    The converged value is 2 each, not 1, and that is the correct answer: both
    rules hear the seed (fire 1), then each hears the OTHER's fire (fire 2) —
    cross-trigger chaining is legal by design. The third hop is where the cycle
    would close, and by then the envelope's scope has accumulated both triggers,
    so the brake refuses it.

    The number that matters is what it is NOT: 30, the storm cap, which is what
    a purely rate-based guard would converge to while the loop ran forever."""
    a = _tag_trigger(name="t-a", tag_pattern="trigger.fired")
    b = _tag_trigger(name="t-b", tag_pattern="trigger.fired")
    await a.save()
    await b.save()
    register_tag_trigger(a)
    register_tag_trigger(b)
    try:
        emit_tag("trigger.fired", target_of("trigger", "seed"), {},
                 {"scope": [target_of("trigger", "seed")]})
        await _settle()
        ra = await Trigger.get_by_id(a.id)
        rb = await Trigger.get_by_id(b.id)
        assert ra.counter == 2 and rb.counter == 2, (
            f"expected convergence at 2 (seed + each other); got a={ra.counter} "
            f"b={rb.counter}. Any higher value means the cycle is still running "
            f"and only the 30/min storm cap is bounding it — i.e. the self-loop "
            f"brake is not holding. (The count seen here is capped by the settle "
            f"window, not by convergence.)"
        )
    finally:
        unregister_tag_trigger(a.id)
        unregister_tag_trigger(b.id)


@async_context
async def test_confirm_failure_is_recorded_not_silent(tmp_path):
    """A confirm rejection wrote nothing anywhere before — which is why
    'I made a trigger and nothing happened' had no answer."""
    from flow_sdk.tags import event_bus

    trigger = _tag_trigger(tag_pattern="cf.*",
                           confirm={"type": "usage_report", "filter": {"id": "nope"}})
    await trigger.save()
    register_tag_trigger(trigger)
    supp = []
    unsub = event_bus.on("trigger.suppressed", supp.append)
    try:
        emit_tag("cf.go", target_of("usage_report", "r-1"))
        await _settle()
        row = await Trigger.get_by_id(trigger.id)
        assert row.counter == 0, "confirm gated the fire"
        assert len(supp) == 1
        assert supp[0].data["reason_code"] == "confirm_failed"
    finally:
        unsub()
        unregister_tag_trigger(trigger.id)
