"""A live session in a chat the host has NO project for must not fail after Approve.

The real case (2026-10-05, prod): a person-to-person chat reached the host over
the hub bridge — the bridge's conversation allowlist carries no ``project_id``,
so the host's row is project-less by design. The guest started a live session
in it, the host clicked Approve, and four seconds later the guest got "The host
could not run this prompt: this conversation is not linked to a project on the
host" instead of an answer: Approve never asked where to run, and the turn it
re-drives reads only ``conversation.project_id``.

Nothing is faked in the bug's own test. The conversation arrives through the
bridge's own upsert, the host approves through the HTTP route, and the test
awaits the route's real detached re-drive (no polling budget) before reading
what the guest was sent. The fix's happy path patches only the worker seam
(``fake_worker``, shared with ``test_run_session_turn``) so no real agent runs.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.app.actions.execute_prompt import process_inbound_prompt
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from tests.api._session_helpers import inbound_prompt_fm, local_project_id, make_session
from tests.api.test_run_session_turn import fake_worker  # noqa: F401 — the shared worker seam

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

NOT_LINKED = "not linked to a project on the host"


async def _redrives() -> None:
    """Await the detached re-drive the approve route started — the real task, not a copy."""
    tasks = [
        t
        for t in asyncio.all_tasks()
        if t is not asyncio.current_task() and "redrive_session_prompts" in repr(t.get_coro())
    ]
    await asyncio.gather(*tasks)


async def _projectless_chat_with_a_pending_session() -> tuple[str, RemoteWorkerSession]:
    """The host's copy of a person-to-person chat, as the hub bridge materializes
    it, with the guest's opening prompt queued while the session awaits approval."""
    conv_id = str(uuid.uuid4())
    await HubWsBridge()._handle_conversation_op(
        "create", conv_id, {"title": "Nir Levy, Eran Shlomo", "initiated_by": "host-local", "participants": []}
    )
    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None and conv.project_id is None  # the real shape, not a hand-cleared field
    rws = await make_session(conv_id, S.PENDING.value)
    await inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4())).save(notify=False)
    return conv_id, rws


async def _sent_to_guest(conv_id: str) -> list[str]:
    return [m.text for m in await FlowMessage.get_all({"conversation_id": conv_id}) if m.text]


async def test_approving_a_session_in_a_projectless_chat_never_fails_the_guest(bootstrapped_client, user):
    conv_id, rws = await _projectless_chat_with_a_pending_session()

    resp = await bootstrapped_client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    await _redrives()

    sent = await _sent_to_guest(conv_id)
    assert not [t for t in sent if NOT_LINKED in t], sent
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status != S.ERROR.value
    # Nowhere to run → the host is asked, the session waits for that answer.
    assert resp.status_code == 409, resp.text
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.PENDING.value


async def test_approving_with_a_picked_project_runs_the_session_there(bootstrapped_client, user, fake_worker):  # noqa: F811
    conv_id, rws = await _projectless_chat_with_a_pending_session()
    project_id = await local_project_id(bootstrapped_client)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"project_id": project_id}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    await _redrives()

    assert len(fake_worker["prompts"]) == 1
    assert any(t.startswith("Prompt response:") for t in await _sent_to_guest(conv_id))
    after = await RemoteWorkerSession.get_one({"id": rws.id})
    assert after.status == S.IDLE.value and after.project_id == project_id

    # A follow-up arrives through the real inbound gate, which used to drop every
    # prompt in a project-less chat before it looked at the session.
    follow_up = inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4()))
    await follow_up.save(notify=False)
    await process_inbound_prompt(follow_up.id, conv_id)
    assert len(fake_worker["prompts"]) == 2


async def test_a_project_without_a_folder_is_refused(bootstrapped_client, user):
    _conv_id, rws = await _projectless_chat_with_a_pending_session()
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"project_id": str(uuid.uuid4())}
    )
    assert resp.status_code == 400, resp.text
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.PENDING.value


async def test_the_guest_is_remembered_before_the_session_goes_live(bootstrapped_client, user, monkeypatch):
    """Cross-OS stress 2026-10-06 (Windows host): Approve flipped the session live —
    and shipped "approved" to the guest — before writing the standing grant, so a
    guest that started its next session at once was asked again."""
    from flow_sdk.builtin.contact_permission import ContactPermission  # noqa: PLC0415

    conv_id, rws = await _projectless_chat_with_a_pending_session()
    granted_when_live: list[bool] = []
    real_emit = RemoteWorkerSession._emit_event

    async def spy(self, kind, **kw):
        if kind == "approved":
            granted_when_live.append(bool(await ContactPermission.get_all({"contact_user_id": self.guest_user_id})))
        return await real_emit(self, kind, **kw)

    monkeypatch.setattr(RemoteWorkerSession, "_emit_event", spy)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True, "remember": "everywhere"}
    )
    await _redrives()

    assert resp.status_code == 200, resp.text
    assert granted_when_live == [True]
