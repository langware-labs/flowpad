"""A drained prompt that is not delivered must not vanish.

`_maybe_drain_queue` pops the FIFO head and *then* calls `prompt()`. The pop
already persisted the removal, so from that point the prompt exists only in
the local `head` variable — delivery has to succeed or the entry has to go
back.

`prompt()` does not raise when it declines: it RETURNS
`ApiSuccessResponse | ApiFailResponse`, and returns a 409 failure whenever a
turn is already in flight (and a failure when a relaunch cannot start). The
drain only guarded `except Exception`, so a refusal fell straight through to
`q.log("injected", ...)` — the entry was recorded as delivered, and the user's
prompt was gone.

`_requeue_failed_launch` already existed for exactly this hazard on the launch
path; the drain simply never used it.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def _make_ap() -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-0000000000d1",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    ap.pty_mode = False
    await ap.save(notify=False)
    return ap


def _queued(ap: AgenticProcess) -> list[str]:
    return [e.get("prompt") for e in ap.queue.read().get("entries", [])]


@pytest.mark.asyncio
async def test_a_refused_prompt_is_not_reported_as_injected(initialize_test_db, monkeypatch) -> None:
    ap = await _make_ap()
    ap.queue.enqueue("do the thing", source="test")

    monkeypatch.setattr(
        AgenticProcess,
        "prompt",
        lambda self, instruction: _refuse(),
        raising=False,
    )
    monkeypatch.setattr(AgenticProcess, "_queue_ready", lambda self, worker_status=None: True, raising=False)

    await ap._maybe_drain_queue("test")

    actions = [e.get("action") for e in ap.queue.log_entries()]
    assert "injected" not in actions, "a refused delivery must never be logged as injected"


@pytest.mark.asyncio
async def test_a_refused_prompt_survives_the_drain(initialize_test_db, monkeypatch) -> None:
    """The prompt is already popped — if delivery is refused it has to go back."""
    ap = await _make_ap()
    ap.queue.enqueue("do the thing", source="test")

    monkeypatch.setattr(AgenticProcess, "prompt", lambda self, instruction: _refuse(), raising=False)
    monkeypatch.setattr(AgenticProcess, "_queue_ready", lambda self, worker_status=None: True, raising=False)

    await ap._maybe_drain_queue("test")

    assert "do the thing" in _queued(ap), "a prompt that was never delivered must not be lost"


@pytest.mark.asyncio
async def test_a_delivered_prompt_is_consumed(initialize_test_db, monkeypatch) -> None:
    """The success path is unchanged: delivered once, gone from the queue."""
    ap = await _make_ap()
    ap.queue.enqueue("do the thing", source="test")

    monkeypatch.setattr(AgenticProcess, "prompt", lambda self, instruction: _accept(), raising=False)
    monkeypatch.setattr(AgenticProcess, "_queue_ready", lambda self, worker_status=None: True, raising=False)

    await ap._maybe_drain_queue("test")

    assert _queued(ap) == []
    assert "injected" in [e.get("action") for e in ap.queue.log_entries()]


async def _refuse():
    return ApiFailResponse(message="a turn is in flight", status_code=409)


async def _accept():
    return ApiSuccessResponse(data={})
