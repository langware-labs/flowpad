"""A finished diagnosis goes to who the person picked -- as a conversation, titled with its one-liner.

Real local DB, real conversations and messages; no hub in a unit run, so delivery fails and the
outbox keeps the messages owed -- exactly what happens signed out or offline.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.flow_message_action import _ticket_title
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.diagnose.share import DiagnoseShare, desk_conversation_id, recipients_label, send_diagnosis_to
from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisSpec
from flow_sdk.schema.data_spec.help_request_spec import HelpRecipient
from flow_sdk.server.routes.bootstrap import get_or_create_local_user

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ONE_LINER = "gtm-studio update fails: an agent.json lists requirements as plain names"
ASKED = "analyze the error: Couldn't update / Something went wrong"
TITLE = _ticket_title(ONE_LINER)


@pytest.fixture(autouse=True)
def storage(tmp_path):
    """Somewhere for an attachment's bytes to live -- the server gives a message one."""
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


def _diagnosis() -> DiagnosisSpec:
    return DiagnosisSpec(status="needs_action", title=ONE_LINER, summary="One agent.json cannot be read.")


def _person(email: str = "eran@x.test", name: str = "Eran Shlomo") -> HelpRecipient:
    return HelpRecipient(kind="person", email=email, name=name)


async def _send(share: DiagnoseShare):
    someone = (await get_or_create_local_user()).typeid
    return await send_diagnosis_to(share, _diagnosis(), ASKED, someone)


async def _messages(conv_id: str) -> list[FlowMessage]:
    return await FlowMessage.get_all(QueryFilter(match={"conversation_id": conv_id}))


async def test_a_person_gets_a_conversation_titled_with_the_one_liner():
    conv_id = str(uuid.uuid4())

    sent = await _send(DiagnoseShare(recipients=[_person()], conversation_id=conv_id))

    assert [(s.conversation_id, s.to) for s in sent] == [(conv_id, "Eran Shlomo")]
    conv = await Conversation.get_one({"id": conv_id})
    assert conv.title == TITLE
    assert [m.get("email") for m in conv.members] == ["eran@x.test"]
    messages = await _messages(conv_id)
    assert [m.text for m in messages][0] == ASKED
    assert messages[1].text.startswith("Diagnostic: " + ONE_LINER)
    assert any("diagnosis.value.json" in str(a.data) or "diagnosis.value.json" in str(getattr(a, "name", ""))
               for a in messages[1].attachment), "the diagnosis rides as its own file"
    assert all(m.owes_delivery for m in messages), "no hub here: the outbox owns them"


async def test_the_help_desk_gets_its_own_ticket_beside_the_people():
    conv_id = str(uuid.uuid4())

    sent = await _send(DiagnoseShare(recipients=[_person(), HelpRecipient(kind="desk", name="Langware help desk")],
                                     conversation_id=conv_id))

    assert {s.conversation_id for s in sent} == {conv_id, desk_conversation_id(conv_id)}
    ticket = await Conversation.get_one({"id": desk_conversation_id(conv_id)})
    assert ticket.kind == "helpdesk" and ticket.title == TITLE and ticket.awaits_hub
    opening, diagnosis = await _messages(ticket.id)
    assert opening.text == f"{ONE_LINER}\n\n{ASKED}", "the hub titles a ticket by its opening line"
    assert _ticket_title(opening.text) == ticket.title, "the hub's title is the one written here"
    assert diagnosis.text.startswith("Diagnostic: " + ONE_LINER)


async def test_sending_again_writes_nothing_new():
    share = DiagnoseShare(recipients=[_person()], conversation_id=str(uuid.uuid4()))

    await _send(share)
    again = await _send(share)

    assert [s.conversation_id for s in again] == [share.conversation_id]
    assert len(await _messages(share.conversation_id)) == 2


async def test_nobody_picked_sends_nothing():
    assert await _send(DiagnoseShare(recipients=[], conversation_id=str(uuid.uuid4()))) == []


def test_a_toast_names_who_got_it():
    desk = HelpRecipient(kind="desk")
    assert recipients_label([_person()]) == "Eran Shlomo"
    assert recipients_label([_person(), desk]) == "Eran Shlomo and the help desk"
    assert recipients_label([]) == ""
