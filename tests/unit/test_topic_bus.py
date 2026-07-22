"""Unified event bus — Python side of the cross-language contract.

The golden fixture (tests/fixtures/flow_event_contract.json) is ALSO parsed by
ui/tests/unit/event-bus.test.ts — the two suites pin one envelope shape and
one matching semantics. Change the fixture only with both suites in hand.
"""
import asyncio
import json
from pathlib import Path

from flow_sdk.topics import FlowEvent, TopicEventBus, emit_topic, event_bus, on_topic
from flow_sdk.topics.bus import target_matches, topic_matches

FIXTURE = json.loads(
    (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
)


# ── contract: matching semantics ──────────────────────────────────────────────


def test_topic_matching_contract_cases():
    for case in FIXTURE["topic_cases"]:
        assert topic_matches(case["pattern"], case["topic"]) is case["matches"], case


def test_target_matching_contract_cases():
    for case in FIXTURE["target_cases"]:
        assert target_matches(case["pattern"], case["target"]) is case["matches"], case


# ── contract: envelope shape ──────────────────────────────────────────────────


def test_envelope_contract_roundtrip():
    """The golden envelope parses and re-serializes without loss or additions."""
    event = FlowEvent.model_validate(FIXTURE["envelope"])
    assert event.model_dump() == FIXTURE["envelope"]


def test_envelope_mints_id_and_bus_stamps_tier_origin():
    # Direct construction: origin is REQUIRED (tier-agnostic wire model —
    # mirror of the TS contract); the BUS stamps its tier at emit().
    e1 = FlowEvent(topic="a.b", target="x:1", ctx={"origin": "sandbox"})
    e2 = FlowEvent(topic="a.b", target="x:1", ctx={"origin": "sandbox"})
    assert e1.id != e2.id  # minted per event
    assert e1.timestamp.endswith("Z") or "+" in e1.timestamp

    bus = TopicEventBus()  # backend default tier
    bus.on("a.*", lambda e: None)
    assert bus.emit("a.b", "x:1").ctx.origin == "local_server"
    sandbox_bus = TopicEventBus(tier="sandbox")
    sandbox_bus.on("a.*", lambda e: None)
    assert sandbox_bus.emit("a.b", "x:1").ctx.origin == "sandbox"


# ── bus behavior ──────────────────────────────────────────────────────────────


def test_emit_routes_by_pattern_and_target_filter():
    bus = TopicEventBus()
    got: list[tuple[str, str]] = []
    bus.on("flow.*", lambda e: got.append(("flow", e.topic)))
    bus.on("*", lambda e: got.append(("all", e.topic)), target="agent:*")
    bus.emit("flow.step.done", "agentic_flow:1")
    bus.emit("agent.status", "agent:9")
    bus.emit("entity.updated", "task:3")
    assert got == [("flow", "flow.step.done"), ("all", "agent.status")]


def test_zero_subscribers_fast_path_returns_none():
    bus = TopicEventBus()
    assert bus.emit("a.b", "x:1") is None


def test_no_match_builds_no_envelope():
    bus = TopicEventBus()
    bus.on("only.this", lambda e: None)
    assert bus.emit("something.else", "x:1") is None


def test_handler_isolation_sync():
    bus = TopicEventBus()
    got: list[str] = []
    bus.on("t.*", lambda e: (_ for _ in ()).throw(RuntimeError("boom")))
    bus.on("t.*", lambda e: got.append(e.topic))
    event = bus.emit("t.x", "x:1")
    assert event is not None and got == ["t.x"]


def test_handler_isolation_async():
    async def _main():
        bus = TopicEventBus()
        got: list[str] = []

        async def bad(e):
            raise RuntimeError("async boom")

        async def good(e):
            got.append(e.topic)

        bus.on("t.*", bad)
        bus.on("t.*", good)
        bus.emit("t.y", "x:1")
        await asyncio.sleep(0.01)  # let scheduled handlers run
        assert got == ["t.y"]

    asyncio.run(_main())


def test_scope_filter_delivers_only_matching_scope():
    bus = TopicEventBus()
    got: list[str] = []
    bus.on("s.*", lambda e: got.append("scoped"), scope=["project:p-1"])
    bus.on("s.*", lambda e: got.append("open"))
    bus.emit("s.a", "x:1", ctx={"scope": ["project:p-1"]})
    bus.emit("s.a", "x:1", ctx={"scope": ["project:OTHER"]})
    bus.emit("s.a", "x:1")  # no scope at all
    assert got == ["scoped", "open", "open", "open"]


def test_deliver_never_remints_the_envelope():
    bus = TopicEventBus()
    seen: list[FlowEvent] = []
    bus.on("flow.*", seen.append)
    original = FlowEvent.model_validate(FIXTURE["envelope"])
    bus.deliver(original)
    assert len(seen) == 1
    assert seen[0].id == FIXTURE["envelope"]["id"]
    assert seen[0].timestamp == FIXTURE["envelope"]["timestamp"]
    assert seen[0].ctx.actor == "user:u-1"


def test_unsubscribe_stops_delivery():
    bus = TopicEventBus()
    got: list[str] = []
    unsub = bus.on("u.*", lambda e: got.append(e.topic))
    bus.emit("u.a", "x:1")
    unsub()
    bus.emit("u.b", "x:1")
    assert got == ["u.a"]


def test_observed_topics_bounded_and_entity_free():
    from flow_sdk.topics.bus import _OBSERVED_CAP

    bus = TopicEventBus()
    # Zero subscribers: emits are still observed (that's the gardening point).
    bus.emit("lonely.topic", "x:1")
    bus.emit("lonely.topic", "x:2")
    observed = bus.observed_topics()
    assert observed["lonely.topic"]["count"] == 2
    assert observed["lonely.topic"]["last_target"] == "x:2"
    assert observed["lonely.topic"]["first_ts"] <= observed["lonely.topic"]["last_ts"]

    # Cap enforced drop-oldest.
    for i in range(_OBSERVED_CAP + 10):
        bus.emit(f"burst.t{i}", "x:1")
    observed = bus.observed_topics()
    assert len(observed) == _OBSERVED_CAP
    assert "lonely.topic" not in observed  # oldest dropped
    assert f"burst.t{_OBSERVED_CAP + 9}" in observed


def test_module_singleton_conveniences():
    got: list[str] = []
    unsub = on_topic("conv.*", lambda e: got.append(e.topic))
    try:
        event = emit_topic("conv.check", "x:1", {"k": 1})
        assert event is not None and event.data == {"k": 1}
        assert got == ["conv.check"]
        assert event_bus is not None
    finally:
        unsub()
