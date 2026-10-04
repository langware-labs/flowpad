"""Native (Flowpad-chat) threads through the real add_message action.

A reply names the message it answers (``reply_to_id``); the sender derives the thread root,
and the native-thread projector puts the root and every reply into ONE local MessageThread
row keyed ``("flowpad", <root id>, <owner>, "")`` — the same row the feed packs and
``?thread=`` filters, exactly like a mailbox thread.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.stream_inbox.native_threads import NATIVE_CHANNEL

pytestmark = pytest.mark.asyncio


async def _local_project_id(client) -> str:
    projects = (await client.get("/api/v1/graph/project")).json()["data"]
    return next(p for p in projects if p.get("uname") == "local")["id"]


async def _make_conversation(client) -> str:
    resp = await client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": await _local_project_id(client), "participants": [{"email": "ron@example.com", "name": "Ron"}]},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["conversation_id"]


def _logged_out(monkeypatch) -> None:
    # Deterministic local send (pending_send): no hub involved, the thread is local work.
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: False)
    monkeypatch.setattr("flow_sdk.app.actions.notification_action.is_logged_in", lambda: False)


async def _send(client, conv_id: str, text: str, reply_to: str | None = None) -> dict:
    body = {"text": text, **({"reply_to_id": reply_to} if reply_to else {})}
    resp = await client.post(f"/api/v1/graph/conversation/{conv_id}/add_message", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "SUCCESS", data
    return data["data"]


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reply_opens_a_thread_rooted_at_the_answered_message(bootstrapped_client, user, monkeypatch):
    _logged_out(monkeypatch)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    root = await _send(client, conv_id, "Please add the founding number")
    reply = await _send(client, conv_id, "On it", reply_to=root["flow_message_id"])

    assert reply["reply_to_id"] == root["flow_message_id"]
    assert reply["thread_root_id"] == root["flow_message_id"]
    assert reply["thread_id"], "the response carries the thread so the sender's bubble groups at once"

    thread = await MessageThread.get_one({"id": reply["thread_id"]})
    assert thread.channel == NATIVE_CHANNEL and thread.thread_key == root["flow_message_id"]
    assert thread.conversation_id == conv_id
    assert thread.title == "Please add the founding number"
    assert thread.message_count == 2
    root_fm = await FlowMessage.get_one({"id": root["flow_message_id"]})
    assert root_fm.thread_id == thread.id, "the root joins the thread its first reply opens"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_reply_to_a_reply_stays_in_the_roots_thread(bootstrapped_client, user, monkeypatch):
    _logged_out(monkeypatch)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    root = await _send(client, conv_id, "root")
    first = await _send(client, conv_id, "first", reply_to=root["flow_message_id"])
    second = await _send(client, conv_id, "second", reply_to=first["flow_message_id"])

    assert second["reply_to_id"] == first["flow_message_id"], "the quote is the exact message answered"
    assert second["thread_root_id"] == root["flow_message_id"], "the thread is the root's"
    assert second["thread_id"] == first["thread_id"]
    assert (await MessageThread.get_one({"id": second["thread_id"]})).message_count == 3
    rows = await MessageThread.get_all({"match": {"conversation_id": conv_id}})
    assert len(rows) == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reply_to_a_message_of_another_conversation_is_refused(bootstrapped_client, user, monkeypatch):
    _logged_out(monkeypatch)
    client = bootstrapped_client
    conv_a = await _make_conversation(client)
    conv_b = await _make_conversation(client)
    elsewhere = await _send(client, conv_b, "other conversation")
    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_a}/add_message",
        json={"text": "nope", "reply_to_id": elsewhere["flow_message_id"]},
    )
    body = resp.json()
    assert resp.status_code == 400 or body.get("status") != "SUCCESS"
    assert "not a message of this conversation" in (body.get("message") or "")


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_transcript_filters_to_one_thread_and_names_it(bootstrapped_client, user, monkeypatch):
    _logged_out(monkeypatch)
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    root = await _send(client, conv_id, "snapshot request")
    await _send(client, conv_id, "unrelated")
    reply = await _send(client, conv_id, "done", reply_to=root["flow_message_id"])

    resp = await client.post(
        "/api/v1/graph/conversation-transcript", json={"conversation_id": conv_id, "thread": root["flow_message_id"]}
    )
    data = resp.json()["data"]
    assert data["thread_id"] == reply["thread_id"]
    assert [m["text"] for m in data["messages"]] == ["snapshot request", "done"]
    assert {m["thread_title"] for m in data["messages"]} == {"snapshot request"}
    assert [t["title"] for t in data["threads"]] == ["snapshot request"]

    bad = await client.post(
        "/api/v1/graph/conversation-transcript", json={"conversation_id": conv_id, "thread": "no-such-thread"}
    )
    assert bad.json()["status"] != "SUCCESS"


async def _arrive(conv_id: str, fm_id: str, text: str, **fields) -> FlowMessage:
    """A member's message as the hub hands it to THIS machine (catch-up / live frame)."""
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message  # noqa: PLC0415

    return await materialize_flow_message(
        {"id": fm_id, "text": text, "sender_id": "peer-1", "sender_name": "Ron", **fields},
        conv_id,
        someone_typeid=None,
        remote=True,
    )


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_receiver_resolves_the_wire_root_to_its_own_thread(bootstrapped_client, user, monkeypatch):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    _logged_out(monkeypatch)
    conv_id = await _make_conversation(bootstrapped_client)
    root_id, reply_id = mint_uuid(), mint_uuid()
    await _arrive(conv_id, root_id, "Take snapshot from the home list")
    await _arrive(conv_id, reply_id, "which home?", reply_to_id=root_id, thread_root_id=root_id)

    reply = await FlowMessage.get_one({"id": reply_id})
    assert reply.reply_to_id == root_id and reply.thread_root_id == root_id, "the hub payload is taken whole"
    thread = await MessageThread.get_one({"id": reply.thread_id})
    assert (thread.channel, thread.thread_key, thread.data_source_id) == (NATIVE_CHANNEL, root_id, "")
    assert thread.message_count == 2
    assert (await FlowMessage.get_one({"id": root_id})).thread_id == thread.id


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_root_that_lands_after_its_reply_joins_the_thread(bootstrapped_client, user, monkeypatch):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    _logged_out(monkeypatch)
    conv_id = await _make_conversation(bootstrapped_client)
    root_id, reply_id = mint_uuid(), mint_uuid()
    await _arrive(conv_id, reply_id, "late answer", reply_to_id=root_id, thread_root_id=root_id)
    thread_id = (await FlowMessage.get_one({"id": reply_id})).thread_id
    assert thread_id, "the reply opens its thread even before the root is here"

    await _arrive(conv_id, root_id, "the question")
    assert (await FlowMessage.get_one({"id": root_id})).thread_id == thread_id
    thread = await MessageThread.get_one({"id": thread_id})
    assert thread.message_count == 2
    assert thread.title == "the question", "the root names the thread once it lands"
