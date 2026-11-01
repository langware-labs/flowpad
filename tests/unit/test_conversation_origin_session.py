"""A session that writes into a conversation (`flow conversation send/new/attach/reply`) is linked to it the way
a launch from the conversation is: the conversation marks it as its session, the session learns the message.
The session never rides the message itself — a message's shared context is what ships to the recipients."""

import json

import pytest

from flow_sdk.app.actions import notification_action as na
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cli.commands import conversation_cmd
from flow_sdk.cli.commands._common import current_process_id
from flow_sdk.db.drivers.db_base_record import TypeId

PROC_ID = "11111111-aaaa-4bbb-9ccc-000000000050"
CONV_ID = "11111111-aaaa-4bbb-9ccc-000000000010"
MSG_ID = "11111111-aaaa-4bbb-9ccc-000000000070"


@pytest.fixture
def rows(monkeypatch):
    proc = AgenticProcess(id=PROC_ID)
    conv = Conversation(id=CONV_ID, title="c")
    saved: list[str] = []

    def loader(row):
        async def get_one(cls, query):  # noqa: ARG001
            return row if row is not None and query.get("id") == row.id else None

        return classmethod(get_one)

    async def save(self, *_a, **_k):
        saved.append(self.get_type())
        return self

    monkeypatch.setattr(AgenticProcess, "get_one", loader(proc))
    monkeypatch.setattr(Conversation, "get_one", loader(conv))
    monkeypatch.setattr(AgenticProcess, "save", save)
    monkeypatch.setattr(Conversation, "save", save)
    return proc, conv, saved


async def test_links_the_session_both_ways_and_marks_it(rows):
    proc, conv, _ = rows
    await na.link_origin_session(CONV_ID, MSG_ID, PROC_ID, None)
    assert TypeId(type="flow_message", id=MSG_ID) in proc.shared_context_entities
    tid = TypeId(type="agentic_process", id=PROC_ID)
    assert tid in conv.shared_context_entities
    assert conv.shared_context_entity_data[str(tid)] == na.SESSION_ROLE


async def test_a_channel_reply_links_only_the_conversation(rows):
    proc, conv, _ = rows
    await na.link_origin_session(CONV_ID, None, PROC_ID, None)
    assert proc.shared_context_entities == []
    assert TypeId(type="agentic_process", id=PROC_ID) in conv.shared_context_entities


async def test_a_second_message_saves_only_what_changed(rows):
    _, _, saved = rows
    await na.link_origin_session(CONV_ID, MSG_ID, PROC_ID, None)
    saved.clear()
    await na.link_origin_session(CONV_ID, "11111111-aaaa-4bbb-9ccc-000000000071", PROC_ID, None)
    assert saved == ["agentic_process"]


async def test_an_unknown_session_links_nothing(rows):
    _, conv, saved = rows
    await na.link_origin_session(CONV_ID, MSG_ID, "11111111-aaaa-4bbb-9ccc-000000000099", None)
    assert conv.shared_context_entities == [] and saved == []


def test_the_cli_names_its_session_only_inside_one(monkeypatch):
    monkeypatch.delenv("FLOWPAD_EXECUTION_SCOPE", raising=False)
    assert current_process_id() is None
    assert conversation_cmd._origin_session() == {}
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", json.dumps([{"type": "agentic_process", "id": PROC_ID}]))
    assert conversation_cmd._origin_session() == {"origin_process": PROC_ID}
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", json.dumps([f"agentic_process-{PROC_ID}"]))
    assert current_process_id() == PROC_ID
