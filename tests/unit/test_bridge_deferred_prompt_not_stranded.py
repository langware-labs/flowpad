"""A body-bearing prompt deferred at CREATE always reaches the session gate.

QC 2026-10-01 (hub_playwright ``live_session_stress``): a session's opening
prompt sat at "Awaiting host · 1 prompt · 0 replies" forever. The bridge defers
a prompt whose body is still UPLOADING and re-fires the gate from the UPDATE that
makes it READY — but it only fired on an UPLOADING→READY *transition* seen by
that handler, and two races took the transition away (instrumented on bob):

* the conversation catch-up pulled the body and stamped READY first, so the
  READY frame arrived with ``prev=ready`` and fired nothing;
* the READY frame arrived while the detached CREATE persist was still running,
  found no row, and was dropped.

Any prompt with a later arrival in the same session was rescued by that
arrival's drain; the LAST prompt of a session had no rescuer. Only the gate is
stubbed; the bridge handler and the row writes are real.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.app.actions import execute_prompt
from flow_sdk.builtin.flow_message import AttachmentType, BodyStatus, FlowMessage
from flow_sdk.cloud_client.hub_bridge import HubWsBridge

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _NoHub:
    def send(self, *_a, **_kw):
        pass


def _prompt(conv_id: str, body_status: BodyStatus) -> FlowMessage:
    fm = FlowMessage.model_validate({
        "conversation_id": conv_id,
        "text": "Please run the following prompt:",
        "sender_id": "guest-cloud-user-id",
        "sender_name": "alice",
        "body_status": body_status.value,
        "attachment_filename": "body.flowmsg",
        "attachment": [{"attachment_type": AttachmentType.TYPE_ID.value, "data": f"prompt-{uuid.uuid4()}"}],
        "remote": True,
    })
    fm.id = str(uuid.uuid4())
    return fm


@pytest.fixture
def gate_calls(monkeypatch):
    calls: list[str] = []
    fired = asyncio.Event()

    async def fake_gate(fm_id: str, _conv_id: str) -> None:
        calls.append(fm_id)
        fired.set()

    monkeypatch.setattr(execute_prompt, "process_inbound_prompt", fake_gate)

    async def no_pull(*_a, **_kw):
        return None

    import flow_sdk.cloud_client.hub_bridge as hub_bridge

    monkeypatch.setattr(hub_bridge, "_maybe_eager_pull_bundle", no_pull)
    return calls, fired


async def test_ready_frame_fires_the_gate_when_catch_up_stamped_ready_first(gate_calls):
    """CAPTURES BUG — the row is already READY, so the frame sees no transition."""
    calls, fired = gate_calls
    conv_id = str(uuid.uuid4())
    fm = _prompt(conv_id, BodyStatus.READY)  # the catch-up pulled the body and stamped READY
    await fm.save(None, notify=False)

    await HubWsBridge(_NoHub())._handle_flow_message_op("update", fm.id, {"body_status": "ready"}, conv_id)
    await asyncio.wait_for(fired.wait(), timeout=2)  # do not increase timeout without approval

    assert calls == [fm.id], "a READY frame for an unrun prompt must reach the gate"


async def test_update_racing_the_create_persist_is_applied_not_dropped(gate_calls):
    """CAPTURES BUG — the READY frame lands while the CREATE is still persisting."""
    calls, fired = gate_calls
    conv_id = str(uuid.uuid4())
    fm = _prompt(conv_id, BodyStatus.UPLOADING)
    bridge = HubWsBridge(_NoHub())
    row_written = asyncio.Event()

    async def slow_create_persist() -> None:
        await row_written.wait()
        await fm.save(None, notify=False)

    bridge._inbound_persists[fm.id] = asyncio.create_task(slow_create_persist())

    await bridge._handle_flow_message_op("update", fm.id, {"body_status": "ready"}, conv_id)
    row_written.set()
    await asyncio.wait_for(fired.wait(), timeout=2)  # do not increase timeout without approval

    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.body_status == BodyStatus.READY, "the READY frame was dropped — the row is stuck UPLOADING"
    assert calls == [fm.id]


async def test_a_late_lower_frame_never_rolls_ready_back(gate_calls):
    conv_id = str(uuid.uuid4())
    fm = _prompt(conv_id, BodyStatus.READY)
    await fm.save(None, notify=False)

    await HubWsBridge(_NoHub())._handle_flow_message_op("update", fm.id, {"body_status": "uploading"}, conv_id)

    assert (await FlowMessage.get_one({"id": fm.id})).body_status == BodyStatus.READY
