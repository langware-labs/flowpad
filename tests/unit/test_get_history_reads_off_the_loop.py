"""``get-history`` reads the transcript on a worker thread, not the event loop.

Perf hunt 2026-11-07 (B3): a 5-9 MB Claude transcript parses for ~0.3 s, and every other
request on the backend waited behind it each time a chat opened. A spy around the real
driver records which thread the read ran on.
"""

from __future__ import annotations

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
    response = await process.get_history_action()

    assert response.data["history"] == []
    assert threads and threads[0] != threading.get_ident(), "the transcript read blocked the event loop"
