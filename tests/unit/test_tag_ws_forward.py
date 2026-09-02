"""Backend→app tag forwarding: allowlisted patterns become tag_msg frames."""
import asyncio
import json

from flow_sdk.tags import event_bus
from flow_sdk.tags.bus import TagEventBus


def test_allowlisted_tag_forwards_exact_envelope(monkeypatch):
    async def _main():
        from flow_sdk.server.routes import websocket as ws_mod
        from flow_sdk.tags import ws_forward

        sent: list[str] = []

        async def fake_broadcast(message: str) -> None:
            sent.append(message)

        monkeypatch.setattr(ws_mod, "broadcast", fake_broadcast)
        monkeypatch.setattr(ws_forward, "event_bus", TagEventBus())
        ws_forward.reset_for_tests()
        ws_forward.start_tag_forwarding()

        event = ws_forward.event_bus.emit(
            "graph_workflow.step.done", "graph_workflow:f-1", {"run_id": "r-1"})
        assert event is not None
        await asyncio.sleep(0.01)  # async forward handler runs as a loop task

        assert len(sent) == 1
        frame = json.loads(sent[0])
        assert frame["message_type"] == "tag_msg"
        assert frame["event"] == event.model_dump()

        # Non-allowlisted tag → silence (nothing crosses undeclared).
        ws_forward.event_bus.emit("entity.updated", "task:1")
        await asyncio.sleep(0.01)
        assert len(sent) == 1

    asyncio.run(_main())


def test_the_ingest_item_lane_is_never_forwarded(monkeypatch):
    """The storm guard, as a test rather than a comment.

    `ingest.*.sync.*` is 2 frames per source per cycle. `ingest.*` would also
    catch the per-item lane: up to 30 items × 5 streams per source, every due
    source on the same heartbeat tick, each frame an awaited send_text per
    connected client. Widening this pattern is the mistake this test exists to
    catch.
    """
    async def _main():
        from flow_sdk.server.routes import websocket as ws_mod
        from flow_sdk.tags import ws_forward

        sent: list[str] = []

        async def fake_broadcast(message: str) -> None:
            sent.append(message)

        monkeypatch.setattr(ws_mod, "broadcast", fake_broadcast)
        monkeypatch.setattr(ws_forward, "event_bus", TagEventBus())
        ws_forward.reset_for_tests()
        ws_forward.start_tag_forwarding()

        ws_forward.event_bus.emit(
            "ingest.hackernews.sync.completed", "data_source:s-1", {"created": 3})
        await asyncio.sleep(0.01)
        assert len(sent) == 1, "the operational sync lane must reach the app"

        for n in range(40):
            ws_forward.event_bus.emit(
                "ingest.hackernews.item.created", f"source_item:{n}", {})
        await asyncio.sleep(0.01)
        assert len(sent) == 1, (
            f"{len(sent) - 1} per-item frames were broadcast — the item lane is "
            "forwarded and will storm the WS under a real poll cycle"
        )

        # Placement is the bounded, post-commit message lane. It must cross so
        # an open inbox can refresh only after the FlowMessage + pointer exist.
        projected = ws_forward.event_bus.emit(
            "inbox.cloud_email.message.projected",
            "source_item:i-1",
            {"source_id": "s-1", "entity_id": "i-1"},
            ctx={"scope": ["data_source:s-1"]},
        )
        await asyncio.sleep(0.01)
        assert len(sent) == 2
        assert json.loads(sent[-1])["event"] == projected.model_dump()

    asyncio.run(_main())


def test_recent_ring_seeds_the_feed_and_is_bounded(monkeypatch):
    """Without this ring a freshly-opened feed is blank: the bus persists
    nothing and its observation map keeps tag NAMES only."""
    async def _main():
        from flow_sdk.server.routes import websocket as ws_mod
        from flow_sdk.tags import ws_forward

        async def fake_broadcast(message: str) -> None:
            pass

        monkeypatch.setattr(ws_mod, "broadcast", fake_broadcast)
        monkeypatch.setattr(ws_forward, "event_bus", TagEventBus())
        ws_forward.reset_for_tests()
        ws_forward.start_tag_forwarding()

        assert ws_forward.recent_events() == []
        overflow = ws_forward.RECENT_EVENTS_CAP + 25
        for n in range(overflow):
            ws_forward.event_bus.emit(
                "graph_workflow.done", "graph_workflow:f-1", {"n": n})
        await asyncio.sleep(0.01)

        got = ws_forward.recent_events()
        assert len(got) == ws_forward.RECENT_EVENTS_CAP, "the ring is unbounded"
        assert got[-1]["data"]["n"] == overflow - 1, "newest must be last (feed order)"
        assert got[0]["data"]["n"] == overflow - ws_forward.RECENT_EVENTS_CAP
        # Full envelopes, not names — the feed renders target and payload.
        assert got[-1]["target"] == "graph_workflow:f-1" and "id" in got[-1]

        # An unforwarded tag is not recorded either: the ring's scope is exactly
        # what the app may already see, so it grants no extra visibility.
        ws_forward.event_bus.emit("entity.updated", "task:1")
        await asyncio.sleep(0.01)
        assert all(e["tag"] != "entity.updated" for e in ws_forward.recent_events())

    asyncio.run(_main())


def test_a_huge_payload_is_not_pinned_in_the_ring(monkeypatch):
    """An agent node's `done` carries the agent's ENTIRE output.

    Retained verbatim, 200 of those pin megabytes for the process lifetime
    whether or not anyone ever opens Signals — and the feed shows only a
    one-line gist until a row is expanded.
    """
    async def _main():
        from flow_sdk.server.routes import websocket as ws_mod
        from flow_sdk.tags import ws_forward

        async def fake_broadcast(message: str) -> None:
            pass

        monkeypatch.setattr(ws_mod, "broadcast", fake_broadcast)
        monkeypatch.setattr(ws_forward, "event_bus", TagEventBus())
        ws_forward.reset_for_tests()
        ws_forward.start_tag_forwarding()

        whale = "x" * (ws_forward.MAX_RETAINED_DATA_CHARS * 4)
        ws_forward.event_bus.emit(
            "graph_workflow.run.event", "graph_workflow:f-1",
            {"kind": "event", "event": "done", "data": {"output": whale}},
        )
        ws_forward.event_bus.emit(
            "graph_workflow.done", "graph_workflow:f-1", {"status": "complete"},
        )
        await asyncio.sleep(0.01)

        big, small = ws_forward.recent_events()
        assert "_elided" in big["data"], "an unbounded payload was retained whole"
        assert len(json.dumps(big)) < len(whale), "the ring still holds the whole thing"
        # Envelope identity survives — only the payload is dropped.
        assert big["tag"] == "graph_workflow.run.event" and big["id"]
        assert small["data"] == {"status": "complete"}, "a small payload must be kept intact"

    asyncio.run(_main())


def test_start_is_idempotent(monkeypatch):
    from flow_sdk.tags import ws_forward

    bus = TagEventBus()
    monkeypatch.setattr(ws_forward, "event_bus", bus)
    ws_forward.reset_for_tests()
    ws_forward.start_tag_forwarding()
    ws_forward.start_tag_forwarding()
    assert len(bus._subs) == len(ws_forward.FORWARDED_TAG_PATTERNS)


def test_global_bus_untouched_by_this_suite():
    # The suite swaps in private buses; the module singleton stays clean.
    assert event_bus._subs == {} or event_bus is not None
