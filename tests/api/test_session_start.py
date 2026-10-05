"""A live session opened before any prompt, and run in a temp folder.

The guest's live-session button opens the session at once (the guest lands in
the session view with the cursor waiting for the first prompt): the route makes
the PENDING row and sends the host a ``requested`` line, which is the session's
one line in the conversation. The host may approve it with "No project", which
runs it in the instance's one temp folder.

Real routes and rows; only the worker seam is patched (``fake_worker``).
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import (
    LIVE_SESSION_EVENT_MARKER_KEY,
    SESSION_START_MARKER_KEY,
    Attachment,
    AttachmentType,
    FlowMessage,
    FlowMessageKind,
)
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, scratch_workdir
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from flow_sdk.instance_settings import get_instance_settings
from tests.api._session_helpers import inbound_prompt_fm, make_conversation, make_session
from tests.api.test_run_session_turn import fake_worker  # noqa: F401 — the shared worker seam

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

HOST = {"user_id": "host-remote", "name": "Nir Levy"}


async def _two_person_conversation(client) -> str:
    conv_id = await make_conversation(client)
    conv = await Conversation.get_one({"id": conv_id})
    conv.members = [*(conv.members or []), HOST]
    await conv.save()
    return conv_id


def _marker(fm: FlowMessage) -> dict:
    for a in fm.attachment or []:
        if a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").startswith("remote_worker_session-"):
            return json.loads(a.prompt_preview or "{}")
    return {}


async def _start(client, conv_id: str) -> dict:
    resp = await client.post(f"/api/v1/graph/conversation/{conv_id}/live-session", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]


async def test_the_button_opens_a_pending_session_and_asks_the_host(bootstrapped_client, user):
    conv_id = await _two_person_conversation(bootstrapped_client)
    data = await _start(bootstrapped_client, conv_id)

    session = await RemoteWorkerSession.get_one({"id": data["id"]})
    assert session.status == S.PENDING.value
    assert session.host_user_id == "host-remote" and session.host_name == "Nir Levy"
    [line] = [m for m in await FlowMessage.get_all({"conversation_id": conv_id}) if m.kind == "session_event"]
    assert line.kind == FlowMessageKind.SESSION_EVENT.value
    assert line.text.endswith("asks Nir Levy for a live session")  # reads right on both sides
    assert line.remote_worker_session_id == session.id
    marker = _marker(line)
    assert marker[LIVE_SESSION_EVENT_MARKER_KEY] == "requested"
    assert marker[SESSION_START_MARKER_KEY] == {"reply_policy": "auto"}  # notifies the host like an opening prompt
    assert marker["snapshot"]["status"] == S.PENDING.value  # the host's mirror materializes from it


async def test_the_button_on_an_open_session_opens_that_one(bootstrapped_client, user):
    conv_id = await _two_person_conversation(bootstrapped_client)
    first = await _start(bootstrapped_client, conv_id)
    again = await _start(bootstrapped_client, conv_id)
    assert again["id"] == first["id"]
    lines = [m for m in await FlowMessage.get_all({"conversation_id": conv_id}) if m.kind == "session_event"]
    assert len(lines) == 1  # no second request


async def test_a_conversation_with_no_one_else_cannot_host_a_session(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    resp = await bootstrapped_client.post(f"/api/v1/graph/conversation/{conv_id}/live-session", json={})
    assert resp.status_code == 400, resp.text


def _inbound_request(conv_id: str, session_id: str) -> FlowMessage:
    fm = FlowMessage(
        text="Eran asks to start a live session on your machine",
        sender_id="guest-remote",
        sender_name="Eran",
        conversation_id=conv_id,
        remote_worker_session_id=session_id,
        kind=FlowMessageKind.SESSION_EVENT.value,
        attachment=[
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"remote_worker_session-{session_id}",
                prompt_preview=json.dumps(
                    {SESSION_START_MARKER_KEY: {"reply_policy": "auto"}, LIVE_SESSION_EVENT_MARKER_KEY: "requested"}
                ),
            )
        ],
    )
    fm.id = str(uuid.uuid4())
    return fm


async def test_the_host_turns_a_request_into_its_pending_session(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    sid = str(uuid.uuid4())
    fm = _inbound_request(conv_id, sid)
    await fm.save(notify=False)

    await ep.process_session_request(fm.id, conv_id)

    session = await RemoteWorkerSession.get_one({"id": sid})
    assert session.status == S.PENDING.value  # waits for Approve
    assert session.starting_message_id == fm.id
    assert session.guest_user_id == "guest-remote"
    assert session.host_user_id  # the host's own identity — `isHost` in the UI


async def test_a_standing_grant_approves_the_request_at_once(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    grant = ContactPermission(
        contact_user_id="guest-remote", project_id=None, allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value]
    )
    await grant.save()
    try:
        sid = str(uuid.uuid4())
        fm = _inbound_request(conv_id, sid)
        await fm.save(notify=False)
        await ep.process_session_request(fm.id, conv_id)
        session = await RemoteWorkerSession.get_one({"id": sid})
        assert session.status == S.IDLE.value and session.approved_via == "standing_grant"
    finally:
        await grant.delete()


async def test_no_project_runs_in_the_instance_temp_folder_always_the_same(
    bootstrapped_client,
    user,
    fake_worker,  # noqa: F811
):
    folder = scratch_workdir()
    assert get_instance_settings().instance_dir in folder.parents  # per instance, never machine-wide
    for _ in range(2):
        conv_id = await make_conversation(bootstrapped_client)
        rws = await make_session(conv_id, S.PENDING.value)
        resp = await bootstrapped_client.post(
            f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True}
        )
        assert resp.json().get("status") == "SUCCESS", resp.text
        session = await RemoteWorkerSession.get_one({"id": rws.id})
        assert session.workdir == str(folder)

    fm = inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4()))
    await fm.save(notify=False)
    conv = await Conversation.get_one({"id": conv_id})
    result = await ep.run_session_turn(session, fm, conv, someone_typeid=str(user.typeid))
    assert result.status == "SUCCESS", getattr(result, "message", None)
    ap = await AgenticProcess.get_one({"id": (await RemoteWorkerSession.get_one({"id": rws.id})).host_process_id})
    assert ap.workdir == str(folder)


async def test_no_project_cannot_be_remembered_for_this_project(bootstrapped_client, user):
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.PENDING.value, guest_user_id="guest-scratch")
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True, "remember": "project"}
    )
    assert resp.status_code == 400, resp.text
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.PENDING.value


async def test_a_session_in_another_folder_gets_its_own_process(bootstrapped_client, user):
    target = f"conversation-{uuid.uuid4()}"
    a1 = await ep._reuse_or_spawn_headless(target, "/tmp/project-a")
    a2 = await ep._reuse_or_spawn_headless(target, "/tmp/project-a")
    b = await ep._reuse_or_spawn_headless(target, "/tmp/scratch-b")
    assert a1.id == a2.id
    assert b.id != a1.id and b.workdir == "/tmp/scratch-b"


async def test_approve_remembers_the_guest_who_then_starts_without_asking(bootstrapped_client, user):
    """ "Approve" (not "Approve once") with "Run (Skip project)": an everywhere grant,
    and the guest's next request in this project-less chat runs at once, in the
    same temp folder — no host click."""
    first_conv = await make_conversation(bootstrapped_client)
    rws = await make_session(first_conv, S.PENDING.value, guest_user_id="guest-remembered")
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True, "remember": "everywhere"}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    grants = await ContactPermission.get_all({"contact_user_id": "guest-remembered"})
    try:
        assert len(grants) == 1 and grants[0].project_id is None

        conv = await Conversation.get_one({"id": first_conv})
        conv.project_id = None  # a person-to-person chat: no project anywhere
        await conv.save()
        sid = str(uuid.uuid4())
        fm = _inbound_request(first_conv, sid)
        fm.sender_id = "guest-remembered"
        await fm.save(notify=False)
        await ep.process_session_request(fm.id, first_conv)

        later = await RemoteWorkerSession.get_one({"id": sid})
        assert later.status == S.IDLE.value and later.approved_via == "standing_grant"
        assert later.workdir == str(scratch_workdir())
    finally:
        for g in await ContactPermission.get_all({"contact_user_id": "guest-remembered"}):
            await g.delete()
