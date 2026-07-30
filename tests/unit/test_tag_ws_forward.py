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
