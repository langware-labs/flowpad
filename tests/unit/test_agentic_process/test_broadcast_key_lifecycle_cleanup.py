"""The broadcast dedup key is released when the process goes down.

``_last_broadcast_key`` is backed by the module-level ``_LAST_BROADCAST_KEYS``
dict (keyed by process id) precisely so it survives the fresh AP instance the
transcript watcher hydrates per streamer event. That lifetime is the point of
the design — and the reason nothing implicit ever frees it: the instance dying
no longer drops the row. ``close()`` and ``delete()`` are the two lifecycle
exits, so each must drop it explicitly, or the dict grows for the lifetime of
the server and a re-opened process starts out deduping against the key it last
broadcast before it went down.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import _LAST_BROADCAST_KEYS
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def _make_ap() -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000001",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    await ap.save(notify=False)
    ap._last_broadcast_key = ("running", True, "thinking")
    assert str(ap.id) in _LAST_BROADCAST_KEYS
    return ap


@pytest.mark.asyncio
async def test_close_releases_broadcast_key(initialize_test_db) -> None:
    ap = await _make_ap()

    assert await ap.close() is True

    assert str(ap.id) not in _LAST_BROADCAST_KEYS
    assert ap._last_broadcast_key is None


@pytest.mark.asyncio
async def test_close_releases_broadcast_key_even_when_teardown_fails(initialize_test_db, monkeypatch) -> None:
    """The clear lives in a ``finally`` — a failed close leaks nothing either."""
    ap = await _make_ap()

    original_save = type(ap).save
    calls: list[None] = []

    async def _boom_once(self, *a, **kw):
        # Only the first save fails: the except arm saves the FAILED status and
        # must be allowed to complete, otherwise close() raises instead of
        # returning False and the test would prove nothing about the arm.
        calls.append(None)
        if len(calls) == 1:
            raise RuntimeError("save exploded")
        return await original_save(self, *a, **kw)

    monkeypatch.setattr(type(ap), "save", _boom_once, raising=False)

    assert await ap.close() is False

    assert str(ap.id) not in _LAST_BROADCAST_KEYS


@pytest.mark.asyncio
async def test_delete_releases_broadcast_key(initialize_test_db) -> None:
    ap = await _make_ap()

    await ap.delete()

    assert str(ap.id) not in _LAST_BROADCAST_KEYS
    assert ap._last_broadcast_key is None
