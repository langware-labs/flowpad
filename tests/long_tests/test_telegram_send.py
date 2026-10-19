"""LIVE: the Telegram driver's send leg, against the real Bot API.

A bot cannot message itself and cannot open a chat uninvited, so an automated
test cannot create INBOUND traffic — that half is validated in the browser
(you ↔ bot). What CAN be pinned live is the send leg and the fact Telegram
makes special: nothing ever echoes a bot's own message, so ``send`` must
record the sent copy itself and the projection must place it.

Needs (skips otherwise):
- ``DEEP_TESTING`` on,
- ``TELEGRAM_BOT_TOKEN`` — the bot's token (from @BotFather),
- ``TELEGRAM_TEST_CHAT_ID`` — a chat the bot is already in, seeded once by
  messaging the bot from your own Telegram account.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from tests.test_settings import test_service_config

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_TEST_CHAT_ID", "")

@pytest.fixture(autouse=True)
def _token(monkeypatch):
    """The bot's token as the driver resolves it: its manifest's credential var, not config."""
    from pydantic import SecretStr

    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

    async def credentials(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})

    monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", credentials)


pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.skipif(not TOKEN, reason="set TELEGRAM_BOT_TOKEN"),
    pytest.mark.skipif(not CHAT_ID, reason="set TELEGRAM_TEST_CHAT_ID (message the bot once to seed a chat)"),
]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_telegram_send_records_its_own_copy():
    t0 = time.perf_counter()

    def mark(label: str) -> None:
        print(f"[{time.perf_counter() - t0:6.2f}s] {label}", flush=True)

    marker = f"tg-send-{uuid.uuid4().hex[:8]}"
    source = DataSource(
        name=f"Telegram send test {uuid.uuid4().hex[:8]}",
        provider="telegram",
        config={},
    )
    await source.save()
    assert source.channel == "telegram", "channel must be stamped at create"
    mark("source saved")

    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    outcome = await DataDriver.loaded("telegram").send(
        source,
        thread_key=CHAT_ID,
        to=CHAT_ID,
        text=f"flowpad send-leg probe {marker}",
    )
    mark("sent")

    assert outcome.external_id.startswith(f"{CHAT_ID}/"), "identity is born at the provider"
    # The Telegram-specific promise: no poll will EVER echo a bot's own
    # message, so the driver records the copy itself.
    assert outcome.recorded is True

    item = await SourceItem.get_one({"data_source_id": source.id, "external_id": outcome.external_id})
    assert item is not None, "the sent copy must be recorded as a SourceItem"
    assert marker in (item.body or "")
    assert item.thread_key == CHAT_ID
    mark("copy recorded")

    # The recorded copy projects like any other message — the outbound half
    # of the conversation is in its thread.
    from flow_sdk.stream_inbox.projection import project_source_item  # noqa: PLC0415

    await project_source_item(item, source=source, notify=False, announce=False)
    fm = await FlowMessage.get_one({"source_item_id": item.id})
    assert fm is not None, "the projection must place the sent copy"
    assert marker in (fm.text or ""), "reads hydrate from the item"
    mark("projected")


def _png(size: int = 64) -> bytes:
    """A real PNG (a solid square) — Telegram rejects a photo it cannot decode."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + b"\xd0\x30\x30" * size
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * size)) + chunk(b"IEND", b""))


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_telegram_files_quote_and_reactions_live(tmp_path):
    """The generic verbs against the real Bot API: a photo quoting a message (its caption carries the
    body), a document, a voice note when ffmpeg can make OGG/Opus, our reaction put and taken back, and
    an emoji outside Telegram's list refused before any request."""
    import shutil
    import subprocess

    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.sources.errors import Rejected  # noqa: PLC0415
    from flow_sdk.sources.files import local_file  # noqa: PLC0415

    marker = f"tg-files-{uuid.uuid4().hex[:8]}"
    source = DataSource(name=f"Telegram files test {marker}", provider="telegram", config={})
    await source.save()
    driver = DataDriver.loaded("telegram")

    probe = await driver.send(source, thread_key=CHAT_ID, to=CHAT_ID, text=f"probe {marker}")
    photo = tmp_path / f"{marker}.png"
    photo.write_bytes(_png())
    doc = tmp_path / f"{marker}.txt"
    doc.write_text("a document from the files leg\n")
    files = [local_file(photo), local_file(doc)]
    if shutil.which("ffmpeg"):
        voice = tmp_path / f"{marker}.ogg"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                        "-c:a", "libopus", str(voice)], check=True)
        files.append(local_file(voice, as_="voice"))

    sent = await driver.send(
        source, thread_key=CHAT_ID, to=CHAT_ID, text=f"photo {marker}", in_reply_to=probe.external_id, files=tuple(files)
    )
    assert len(sent.parts) == len(files), "one Telegram message per file"
    assert sent.recorded
    first = await SourceItem.get_one({"data_source_id": source.id, "external_id": sent.parts[0]})
    assert first.reply_to_external_id == probe.external_id, "the photo quotes the probe"
    assert f"photo {marker}" in (first.body or ""), "the body rode as the photo's caption"

    target = first.origin
    await driver.react(source, target, "👍")
    with pytest.raises(Rejected):
        await driver.react(source, target, "🦩")
    await driver.react(source, target, "", remove=True)
