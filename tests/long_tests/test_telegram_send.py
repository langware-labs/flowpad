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

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from tests.test_settings import test_service_config

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_TEST_CHAT_ID", "")

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
        name="Telegram send test",
        provider="telegram",
        config={"bot_token": TOKEN},
    )
    await source.save()
    assert source.channel == "telegram", "channel must be stamped at create"
    mark("source saved")

    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    outcome = await get_driver("telegram").send(
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
    from flow_sdk.inbox.projection import project_source_item  # noqa: PLC0415

    await project_source_item(item, source=source, notify=False, announce=False)
    fm = await FlowMessage.get_one({"source_item_id": item.id})
    assert fm is not None, "the projection must place the sent copy"
    assert marker in (fm.text or ""), "reads hydrate from the item"
    mark("projected")
