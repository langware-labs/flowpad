"""Unified event bus — Python side of the cross-language contract.

The golden fixture (tests/fixtures/flow_event_contract.json) is ALSO parsed by
ui/tests/unit/event-bus.test.ts — the two suites pin one envelope shape and
one matching semantics. Change the fixture only with both suites in hand.
"""
import asyncio
import json
from pathlib import Path

from flow_sdk.tags import FlowEvent, TagEventBus, emit_tag, event_bus, on_tag
from flow_sdk.tags.bus import tag_matches, target_matches

FIXTURE = json.loads(
    (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
)


# ── contract: matching semantics ──────────────────────────────────────────────


def test_tag_matching_contract_cases():
    for case in FIXTURE["tag_cases"]:
        assert tag_matches(case["pattern"], case["tag"]) is case["matches"], case


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
    e1 = FlowEvent(tag="a.b", target="x:1", ctx={"origin": "sandbox"})
    e2 = FlowEvent(tag="a.b", target="x:1", ctx={"origin": "sandbox"})
    assert e1.id != e2.id  # minted per event
    assert e1.timestamp.endswith("Z") or "+" in e1.timestamp

    bus = TagEventBus()  # backend default tier
    bus.on("a.*", lambda e: None)
    assert bus.emit("a.b", "x:1").ctx.origin == "local_server"
    sandbox_bus = TagEventBus(tier="sandbox")
    sandbox_bus.on("a.*", lambda e: None)
    assert sandbox_bus.emit("a.b", "x:1").ctx.origin == "sandbox"


# ── bus behavior ──────────────────────────────────────────────────────────────


def test_emit_routes_by_pattern_and_target_filter():
    bus = TagEventBus()
    got: list[tuple[str, str]] = []
    bus.on("graph_workflow.*", lambda e: got.append(("graph_workflow", e.tag)))
    bus.on("*", lambda e: got.append(("all", e.tag)), target="agent:*")
    bus.emit("graph_workflow.step.done", "graph_workflow:1")
    bus.emit("agent.status", "agent:9")
    bus.emit("entity.updated", "task:3")
    assert got == [("graph_workflow", "graph_workflow.step.done"), ("all", "agent.status")]


def test_zero_subscribers_fast_path_returns_none():
    bus = TagEventBus()
    assert bus.emit("a.b", "x:1") is None


def test_no_match_builds_no_envelope():
    bus = TagEventBus()
    bus.on("only.this", lambda e: None)
    assert bus.emit("something.else", "x:1") is None


def test_handler_isolation_sync():
    bus = TagEventBus()
    got: list[str] = []
    bus.on("t.*", lambda e: (_ for _ in ()).throw(RuntimeError("boom")))
    bus.on("t.*", lambda e: got.append(e.tag))
    event = bus.emit("t.x", "x:1")
    assert event is not None and got == ["t.x"]


def test_handler_isolation_async():
    async def _main():
        bus = TagEventBus()
        got: list[str] = []

        async def bad(e):
            raise RuntimeError("async boom")

        async def good(e):
            got.append(e.tag)

        bus.on("t.*", bad)
        bus.on("t.*", good)
        bus.emit("t.y", "x:1")
        await asyncio.sleep(0.01)  # let scheduled handlers run
        assert got == ["t.y"]

    asyncio.run(_main())


def test_scope_filter_delivers_only_matching_scope():
    bus = TagEventBus()
    got: list[str] = []
    bus.on("s.*", lambda e: got.append("scoped"), scope=["project:p-1"])
    bus.on("s.*", lambda e: got.append("open"))
    bus.emit("s.a", "x:1", ctx={"scope": ["project:p-1"]})
    bus.emit("s.a", "x:1", ctx={"scope": ["project:OTHER"]})
    bus.emit("s.a", "x:1")  # no scope at all
    assert got == ["scoped", "open", "open", "open"]


def test_deliver_never_remints_the_envelope():
    bus = TagEventBus()
    seen: list[FlowEvent] = []
    bus.on("graph_workflow.*", seen.append)
    original = FlowEvent.model_validate(FIXTURE["envelope"])
    bus.deliver(original)
    assert len(seen) == 1
    assert seen[0].id == FIXTURE["envelope"]["id"]
    assert seen[0].timestamp == FIXTURE["envelope"]["timestamp"]
    assert seen[0].ctx.actor == "user:u-1"


def test_unsubscribe_stops_delivery():
    bus = TagEventBus()
    got: list[str] = []
    unsub = bus.on("u.*", lambda e: got.append(e.tag))
    bus.emit("u.a", "x:1")
    unsub()
    bus.emit("u.b", "x:1")
    assert got == ["u.a"]


def test_observed_tags_bounded_and_entity_free():
    from flow_sdk.tags.bus import _OBSERVED_CAP

    bus = TagEventBus()
    # Zero subscribers: emits are still observed (that's the gardening point).
    bus.emit("lonely.tag", "x:1")
    bus.emit("lonely.tag", "x:2")
    observed = bus.observed_tags()
    assert observed["lonely.tag"]["count"] == 2
    assert observed["lonely.tag"]["last_target"] == "x:2"
    assert observed["lonely.tag"]["first_ts"] <= observed["lonely.tag"]["last_ts"]

    # Cap enforced drop-oldest.
    for i in range(_OBSERVED_CAP + 10):
        bus.emit(f"burst.t{i}", "x:1")
    observed = bus.observed_tags()
    assert len(observed) == _OBSERVED_CAP
    assert "lonely.tag" not in observed  # oldest dropped
    assert f"burst.t{_OBSERVED_CAP + 9}" in observed


def test_module_singleton_conveniences():
    got: list[str] = []
    unsub = on_tag("conv.*", lambda e: got.append(e.tag))
    try:
        event = emit_tag("conv.check", "x:1", {"k": 1})
        assert event is not None and event.data == {"k": 1}
        assert got == ["conv.check"]
        assert event_bus is not None
    finally:
        unsub()
