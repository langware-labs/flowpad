"""``get-history`` reads and encodes the transcript on a worker thread, not the event loop.

Perf hunt 2026-11-07 (B3): a 5-9 MB Claude transcript parses for ~0.3 s, and every other
request on the backend waited behind it each time a chat opened. A spy around the real
driver records which thread the read ran on.
"""

from __future__ import annotations

import json
import threading

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess


async def test_history_is_read_off_the_loop(monkeypatch):
    process = AgenticProcess(id=mint_uuid(), session_id=str(mint_uuid()), worker_type="claude_code", workdir="/repo")
    driver_cls = type(process.driver)
    real = driver_cls.load_history
    threads: list[int] = []

    def spy(self, proc):
        threads.append(threading.get_ident())
        return real(self, proc)

    monkeypatch.setattr(driver_cls, "load_history", spy)
    body = json.loads((await process.get_history_action()).body)

    assert body["status"] == "SUCCESS" and body["data"]["history"] == []
    assert threads and threads[0] != threading.get_ident(), "the transcript read blocked the event loop"


async def test_history_carries_no_derived_text(monkeypatch):
    """The client rebuilds each frame from its value; the XML and content renderings were half the bytes."""
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

    process = AgenticProcess(id=mint_uuid(), session_id=str(mint_uuid()), worker_type="claude_code", workdir="/repo")
    frame = FlowData(flow_value="hello", attributes={"element-type": "chat", "i": "1"})
    monkeypatch.setattr(type(process.driver), "load_history", lambda self, proc: [frame])

    (item,) = json.loads((await process.get_history_action()).body)["data"]["history"]
    assert item["flow_value"] == "hello" and item["attributes"]["element-type"] == "chat"
    assert not {"to_xml", "content", "start_tag_xml", "end_tag_xml"} & item.keys()


async def test_history_limit_returns_the_newest_rows_and_the_total(monkeypatch):
    """A long chat rendered nothing until its whole transcript (up to 9.2 MB) arrived."""
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

    process = AgenticProcess(id=mint_uuid(), session_id=str(mint_uuid()), worker_type="claude_code", workdir="/repo")
    frames = [FlowData(flow_value=f"m{i}", attributes={"element-type": "chat", "i": str(i)}) for i in range(5)]
    monkeypatch.setattr(type(process.driver), "load_history", lambda self, proc: frames)

    # As the route delivers it: a query parameter is a string.
    page = json.loads((await process.get_history_action(limit="2")).body)["data"]
    assert [row["flow_value"] for row in page["history"]] == ["m3", "m4"]
    assert page["count"] == 2 and page["total"] == 5

    everything = json.loads((await process.get_history_action()).body)["data"]
    assert everything["count"] == everything["total"] == 5
