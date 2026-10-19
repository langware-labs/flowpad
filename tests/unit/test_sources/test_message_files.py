"""Files and reactions on a message channel: the generic rules every driver inherits — what a channel
takes (``FileSupport``), the refusal before any provider I/O, how one send splits into provider
messages, and the in-memory channel that stands in for a provider."""

from __future__ import annotations

import json
import urllib.request

import pytest

from flow_sdk.sources import MemoryMessages, capabilities_of
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.files import FileSupport, local_file, plan_parts, read_file, resolve_files
from flow_sdk.sources.testing.http import local_http_server
from flow_sdk.sources.values import CloudOrigin, FileItem, FileKind, MessageData, MessageFileData

WHATSAPP_LIKE = FileSupport(
    kinds=frozenset(FileKind),
    per_message=1,
    max_bytes={FileKind.IMAGE: 5_000_000},
    caption_max=1024,
    caption_kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.DOCUMENT}),
)
SLACK_LIKE = FileSupport(kinds=frozenset({FileKind.IMAGE, FileKind.DOCUMENT}), per_message=10)


@pytest.fixture
def photo(tmp_path):
    p = tmp_path / "site.jpg"
    p.write_bytes(b"\xff\xd8jpeg")
    return p


@pytest.fixture
def invoice(tmp_path):
    p = tmp_path / "invoice.pdf"
    p.write_bytes(b"%PDF-1.4")
    return p


class TestLocalFile:
    def test_auto_takes_the_kind_from_the_media_type(self, photo, invoice):
        assert local_file(photo).data.as_ == FileKind.IMAGE
        assert local_file(invoice).data.as_ == FileKind.DOCUMENT
        f = local_file(photo)
        assert f.origin.kind == "local" and f.data.path == str(photo) and f.data.size == 6
        assert f.data.media_type == "image/jpeg" and read_file(f) == b"\xff\xd8jpeg"

    def test_an_explicit_kind_wins(self, tmp_path):
        note = tmp_path / "note.ogg"
        note.write_bytes(b"OggS")
        assert local_file(note, as_="voice").data.as_ == FileKind.VOICE
        assert local_file(note).data.as_ == FileKind.AUDIO


class TestResolveFiles:
    def test_files_the_channel_takes_pass_unchanged(self, photo, invoice):
        files = (local_file(photo), local_file(invoice))
        assert resolve_files(files, WHATSAPP_LIKE, title="WhatsApp") == files

    def test_a_channel_without_files_refuses(self, photo):
        with pytest.raises(ValueError, match="Telegram does not send files"):
            resolve_files((local_file(photo),), FileSupport(), title="Telegram")

    def test_an_oversized_file_is_refused_with_the_fix(self, tmp_path):
        big = tmp_path / "chart.png"
        big.write_bytes(b"x" * 7_200_000)
        with pytest.raises(ValueError, match=r"WhatsApp images are 5.0 MB at most; chart.png is 7.2 MB\. Send it with as_='document'"):
            resolve_files((local_file(big),), WHATSAPP_LIKE, title="WhatsApp")

    def test_a_kind_the_channel_cannot_show_is_refused(self, tmp_path):
        note = tmp_path / "note.ogg"
        note.write_bytes(b"OggS")
        with pytest.raises(ValueError, match="cannot send a voice"):
            resolve_files((local_file(note, as_="voice"),), SLACK_LIKE, title="Slack")

    def test_a_caption_on_an_uncaptioned_kind_is_refused(self, tmp_path):
        note = tmp_path / "note.ogg"
        note.write_bytes(b"OggS")
        with pytest.raises(ValueError, match="no caption on a voice"):
            resolve_files((local_file(note, as_="voice", caption="hi"),), WHATSAPP_LIKE, title="WhatsApp")

    def test_a_missing_file_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="no such file"):
            resolve_files((local_file(tmp_path / "gone.png"),), WHATSAPP_LIKE, title="WhatsApp")

    def test_a_message_size_limit_counts_every_file(self, photo, invoice):
        tight = FileSupport(kinds=frozenset(FileKind), per_message=10, max_message_bytes=10)
        with pytest.raises(ValueError, match="messages carry"):
            resolve_files((local_file(photo), local_file(invoice)), tight, title="Email")


class TestPlanParts:
    def test_text_only_is_one_part_that_quotes(self):
        (part,) = plan_parts(WHATSAPP_LIKE, "hi", (), quote=True)
        assert part.text == "hi" and part.files == () and part.quotes

    def test_one_file_per_message_fans_out_and_the_body_becomes_the_first_caption(self, photo, invoice):
        parts = plan_parts(WHATSAPP_LIKE, "Here they are", (local_file(invoice), local_file(photo)), quote=True)
        assert [len(p.files) for p in parts] == [1, 1]
        assert parts[0].text is None and parts[0].files[0].data.caption == "Here they are"
        assert [p.quotes for p in parts] == [True, False]

    def test_a_body_an_uncaptioned_first_file_cannot_carry_goes_first(self, tmp_path, photo):
        note = tmp_path / "note.ogg"
        note.write_bytes(b"OggS")
        parts = plan_parts(WHATSAPP_LIKE, "listen", (local_file(note, as_="voice"), local_file(photo)), quote=True)
        assert [(p.text, len(p.files), p.quotes) for p in parts] == [("listen", 0, True), (None, 1, False), (None, 1, False)]

    def test_a_channel_that_carries_many_sends_the_body_with_them(self, photo, invoice):
        (part,) = plan_parts(SLACK_LIKE, "both", (local_file(photo), local_file(invoice)), quote=False)
        assert part.text == "both" and len(part.files) == 2 and not part.quotes


class TestMemoryChannel:
    async def test_files_and_reactions_are_capabilities(self):
        caps = capabilities_of(MemoryMessages.of())
        assert "openable" in caps and "reacting" in caps

    async def test_a_local_file_is_sent_and_a_foreign_one_is_not(self, photo):
        s = MemoryMessages.of()
        async with s:
            chat = (await s.receive(MessageData(text="q", conversation=s.origin("c1")))).data.conversation
            sent = await s.send(MessageData(conversation=chat, attachments=(local_file(photo),)))
            assert sent.data.attachments[0].data.name == "site.jpg"
            foreign = FileItem(origin=CloudOrigin(kind="x", namespace="y", key="z"), data=MessageFileData())
            with pytest.raises(ValueError, match="local file"):
                await s.send(MessageData(text="x", conversation=chat, attachments=(foreign,)))

    async def test_open_serves_a_received_files_bytes(self):
        s = MemoryMessages.of()
        media = FileItem(origin=CloudOrigin(kind="memory", namespace="media", key="m1"), data=MessageFileData(name="p.jpg"))
        async with s:
            await s.receive(MessageData(text="", conversation=s.origin("c1"), attachments=(media,)), blobs={media.origin: b"abcdef"})
            got = b""
            async with s.open(media, chunk_size=4) as chunks:
                async for chunk in chunks:
                    got += chunk
            assert got == b"abcdef"

    async def test_one_reaction_per_actor_and_an_unshowable_emoji_is_refused(self):
        s = MemoryMessages.of()
        async with s:
            m = await s.receive(MessageData(text="q", conversation=s.origin("c1")))
            await s.react(m.origin, "👀")
            await s.react(m.origin, "✅")
            assert s.reacted[m.origin] == "✅"
            with pytest.raises(Rejected):
                await s.react(m.origin, "🦄")
            await s.unreact(m.origin)
            assert m.origin not in s.reacted


def test_the_loopback_server_keeps_raw_bytes_and_serves_delete():
    seen = []

    def respond(path, headers):
        seen.append((headers.get("_method"), headers.get("_raw")))
        return 200, json.dumps({"ok": True}).encode(), {"Content-Type": "application/json"}

    with local_http_server(respond) as base:
        urllib.request.urlopen(urllib.request.Request(base + "/up", data=b"\x00\xff\x10", method="POST"), timeout=5)
        urllib.request.urlopen(urllib.request.Request(base + "/x", method="DELETE"), timeout=5)
    assert seen == [("POST", b"\x00\xff\x10"), ("DELETE", b"")]
