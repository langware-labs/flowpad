"""The AgenticProcess transcript subscriber reports whether it claims a session.

``_route_to_ap`` returns True when a process row owns the session_id and
False otherwise. The registry's startup catch-up reads that value to decide
whether the parsed streamer has a reader worth keeping (see
``TranscriptStreamerRegistry.catch_up``).

Real rows in the test DB; the only patch is the AP's ``on_transcript_change``
spy, which is downstream of the value under test.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap
from flow_sdk.flowpad_types.enums import WorkerType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def test_unowned_session_is_not_claimed(initialize_test_db) -> None:
    sid = str(uuid.uuid4())
    assert await _route_to_ap(sid, Path("/tmp/x.jsonl"), []) is False
    assert await _route_to_ap("", Path("/tmp/x.jsonl"), []) is False


async def test_owned_session_is_claimed_and_forwarded(initialize_test_db, monkeypatch) -> None:
    sid = str(uuid.uuid4())
    ap = AgenticProcess(id=str(uuid.uuid4()), session_id=sid, worker_type=WorkerType.CLAUDE_CODE)
    await ap._db.save(ap)

    forwarded: list[str] = []

    async def spy(self, jsonl_path, entries):
        forwarded.append(self.id)

    monkeypatch.setattr(AgenticProcess, "on_transcript_change", spy)
    assert await _route_to_ap(sid, Path("/tmp/x.jsonl"), ["e1"]) is True
    assert forwarded == [ap.id]
