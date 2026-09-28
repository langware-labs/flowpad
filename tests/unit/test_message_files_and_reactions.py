"""Files, quote-replies and reactions on a channel, end to end over one scripted provider.

The path a real channel takes: a traversal copies each inbound file's bytes while the session is
open; the projection hands them to the conversation's message as FILE attachments; a reaction report
lands on the message it names (and is never a message itself); a send checks its files against the
channel before any provider I/O, fans them out one per provider message and quotes only the message
it was asked to."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.record_paths import data_dir_for
from flow_sdk.ingest.sync import sync_source
from flow_sdk.sources.errors import Rejected
from flow_sdk.stream_inbox.projection import project_source_item
from flow_sdk.stream_inbox.reactions import OURS
from tests.utils.fake_source import scripted_provider

pytestmark = [
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.usefixtures("fresh_user_scope"),
]

ME = "me@chat.test"
DANA = "dana@chat.test"
PROVIDER = "chatfiles"


async def _source() -> DataSource:
    # Its own account: a source saved for an account that already has one adopts that row.
    me = f"{uuid.uuid4().hex[:8]}-{ME}"
    src = DataSource(name=f"chat {uuid.uuid4().hex[:8]}", provider=PROVIDER, account_key=me, config={"address": me})
    await src.save()
    return src


async def _land(src: DataSource, key: str) -> tuple[SourceItem, FlowMessage]:
    await sync_source(src)
    row = await SourceItem.get_one({"data_source_id": str(src.id), "external_id": key})
    await project_source_item(row, source=src, announce=False)
    return await SourceItem.get_one({"id": str(row.id)}), await FlowMessage.get_one({"source_item_id": str(row.id)})


async def _photo_from_dana(script, src, key="m1") -> tuple[SourceItem, FlowMessage]:
    script.push({
        "external_id": key, "author": DANA, "thread_key": "t1", "body": "the crack",
        "files": [{"key": f"media-{key}", "name": "IMG_0412.jpg", "media_type": "image/jpeg", "as_": "image", "bytes": b"\xff\xd8JPEG"}],
    })
    return await _land(src, key)


async def test_an_inbound_file_is_copied_while_the_session_is_open_and_lands_on_the_message():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        row, message = await _photo_from_dana(script, src)

    (staged,) = [f.data for f in row.data.attachments]
    assert staged.name == "IMG_0412.jpg" and staged.as_ == "image" and staged.fetch_error is None
    assert Path(staged.path).read_bytes() == b"\xff\xd8JPEG"
    assert Path(staged.path).is_relative_to(data_dir_for("data_source", src.id) / "files")
    (attachment,) = message.attachment
    assert (attachment.attachment_type, attachment.data) == ("file", "data/IMG_0412.jpg")
    assert (data_dir_for("flow_message", message.id) / "embedded" / "data/IMG_0412.jpg").read_bytes() == b"\xff\xd8JPEG"


async def test_a_file_whose_link_expired_keeps_its_metadata_and_says_why():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        script.push({"external_id": "m2", "author": DANA, "thread_key": "t1", "files": [{"key": "gone", "name": "late.pdf"}]})
        row, message = await _land(src, "m2")

    (lost,) = [f.data for f in row.data.attachments]
    assert lost.path is None and "expired" in lost.fetch_error
    assert [a.data for a in message.attachment] == ["data/late.pdf"], "shown as not downloaded, never dropped"


async def test_a_reaction_lands_on_its_message_and_is_never_a_message():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        row, _ = await _photo_from_dana(script, src)
        script.push({"reaction": {"target": "m1", "emojis": ["👍"], "author": DANA}})
        await sync_source(src)
        script.push({"reaction": {"target": "m1", "emojis": ["❤️"], "author": DANA}})  # one each: it replaces
        await sync_source(src)
        script.push({"reaction": {"target": "not-here", "emojis": ["🔥"], "author": DANA}})
        await sync_source(src)

        row = await SourceItem.get_one({"id": str(row.id)})
        message = await FlowMessage.get_one({"source_item_id": str(row.id)})
        rows = await SourceItem.get_all({"data_source_id": str(src.id)})

    assert [(r.emoji, r.by, r.ours) for r in row.reactions] == [("❤️", DANA, False)]
    assert message.reactions == row.reactions
    assert len(rows) == 1, "a reaction is state on a message, never a row of its own"


async def test_we_react_replace_and_take_it_back_and_an_emoji_the_channel_cannot_show_is_refused():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        _, message = await _photo_from_dana(script, src)
        chat = await Conversation.get_one({"id": message.conversation_id})

        await chat.react(message, "👀")
        after = await chat.react(message, "✅")
        assert [(r.emoji, r.by, r.ours) for r in after] == [("✅", OURS, True)]
        with pytest.raises(Rejected):
            await chat.react(message, "🦄")
        assert await chat.unreact(message) == []
        stored = await FlowMessage.get_one({"id": str(message.id)})

    assert script.reacted == [("m1", "👀", False), ("m1", "✅", False), ("m1", "", True)]
    assert stored.reactions == []


async def test_a_send_quotes_the_chosen_message_and_its_files_fan_out_with_the_body_as_the_first_caption(tmp_path):
    photo, invoice = tmp_path / "site.jpg", tmp_path / "invoice.pdf"
    photo.write_bytes(b"\xff\xd8site")
    invoice.write_bytes(b"%PDF")
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        _, question = await _photo_from_dana(script, src)
        script.push({"external_id": "m3", "author": DANA, "thread_key": "t1", "body": "and the invoice?"})
        await _land(src, "m3")
        chat = await Conversation.get_one({"id": question.conversation_id})

        outcome = await chat.send("Here's the invoice and the site photo.", reply_to=question, files=[invoice, str(photo)])

    first, second = script.sent
    assert first["in_reply_to"] == "m1", "the chosen message, not the newest one"
    assert second["in_reply_to"] == "", "only the first part quotes"
    assert [f["name"] for f in first["files"]] == ["invoice.pdf"] and first["files"][0]["caption"] == "Here's the invoice and the site photo."
    assert [f["name"] for f in second["files"]] == ["site.jpg"] and first["text"] == ""
    assert outcome.parts == (first["external_id"], second["external_id"]) and outcome.recorded


async def test_a_file_the_channel_cannot_take_is_refused_before_anything_is_sent(tmp_path):
    big = tmp_path / "chart.png"
    big.write_bytes(b"x" * 5_100_000)
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        _, question = await _photo_from_dana(script, src)
        chat = await Conversation.get_one({"id": question.conversation_id})
        with pytest.raises(ValueError, match=r"images are 5.0 MB at most; chart.png is 5.1 MB\. Send it with as_='document'"):
            await chat.send("chart", files=[big])
    assert script.sent == []


async def test_a_plain_send_does_not_quote_on_a_quoting_channel():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        _, question = await _photo_from_dana(script, src)
        chat = await Conversation.get_one({"id": question.conversation_id})
        await chat.send("ok")
    assert script.sent[0]["in_reply_to"] == ""


async def test_the_channel_says_what_it_can_do():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        _, message = await _photo_from_dana(script, src)
        chat = await Conversation.get_one({"id": message.conversation_id})
        spec = chat.channel_spec  # read while the driver is registered: the traits are its class's
    assert (spec.accepts_attachments, spec.quotes, spec.reacts) == (True, True, True)
    assert chat.channel_provider == PROVIDER
