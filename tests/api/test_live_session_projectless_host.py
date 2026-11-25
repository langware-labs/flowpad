"""A live session always has a folder to run in on the host.

With no project picked, and none that has a folder on the host, it runs in the
instance's temp folder: Approve is never refused for it and no turn fails for it.

The conversation arrives through the bridge's own upsert, the host approves
through the HTTP route, and the test awaits the route's real detached re-drive
(no polling budget) before reading what the guest was sent. Only the worker seam
is patched (``fake_worker``, shared with ``test_run_session_turn``).
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.app.actions.execute_prompt import process_inbound_prompt
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, scratch_workdir
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from tests.api._session_helpers import inbound_prompt_fm, local_project_id, make_session
from tests.api.test_run_session_turn import fake_worker  # noqa: F401 — the shared worker seam

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

COULD_NOT_RUN = "The host could not run this prompt"


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
        "create", conv_id, {"title": "Bob Example, Dan Example", "initiated_by": "host-local", "members": []}
    )
    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None and conv.project_id is None  # the real shape, not a hand-cleared field
    rws = await make_session(conv_id, S.PENDING.value)
    await inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4())).save(notify=False)
    return conv_id, rws


async def _sent_to_guest(conv_id: str) -> list[str]:
    return [m.text for m in await FlowMessage.get_all({"conversation_id": conv_id}) if m.text]


async def _ran_in_the_temp_folder(conv_id: str, session_id: str) -> None:
    """Nothing told the guest it could not run, and the worker was started in the temp folder."""
    assert not [t for t in await _sent_to_guest(conv_id) if COULD_NOT_RUN in t]
    session = await RemoteWorkerSession.get_one({"id": session_id})
    assert session.status == S.IDLE.value
    ap = await AgenticProcess.get_one({"id": session.host_process_id})
    assert ap.workdir == str(scratch_workdir())


@pytest.mark.parametrize("conversation_project", [None, "a project with no folder on this machine"])
async def test_approving_with_nothing_picked_runs_in_the_temp_folder(
    bootstrapped_client, user, fake_worker, conversation_project  # noqa: F811
):
    """The second case is the real one (2026-11-25, prod): Approve took the conversation's
    project unchecked, and the guest got "the host's project has no folder to run in"."""
    conv_id, rws = await _projectless_chat_with_a_pending_session()
    if conversation_project:
        conv = await Conversation.get_one({"id": conv_id})
        conv.project_id = str(uuid.uuid4())
        await conv.save()

    resp = await bootstrapped_client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text
    await _redrives()

    assert len(fake_worker["prompts"]) == 1
    await _ran_in_the_temp_folder(conv_id, rws.id)


async def test_a_session_approved_into_a_project_without_a_folder_still_runs(bootstrapped_client, user, fake_worker):  # noqa: F811
    """A row approved before the place was checked: its next prompt runs, in the temp folder."""
    conv_id, rws = await _projectless_chat_with_a_pending_session()
    rws.project_id = str(uuid.uuid4())
    rws.status = S.ERROR.value
    await rws.save(notify=False)

    retry = inbound_prompt_fm(conv_id, rws.id, fm_id=str(uuid.uuid4()))
    await retry.save(notify=False)
    await process_inbound_prompt(retry.id, conv_id)

    await _ran_in_the_temp_folder(conv_id, rws.id)


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
