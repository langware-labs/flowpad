"""An agent never answers its own reply — on a channel that admits everyone, whose echo of that reply
carries no address of ours.

That is the case the allowlist cannot save: an open channel (a help desk) admits every author, and a
provider's copy of what we sent may be signed by an identity the source does not know as its own —
the Slack double's echo is signed ``U1``. What says "ours" is the send itself: the reply is recorded at
send time, marked ``sent_by_us``, and the echo lands on that same row (same natural key), so the serve
loop's drain never hands it over.

A real agent turn: ``MockDriver`` (``tests/utils/mock_worker.py``) answers "Mock reply: …", no model.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.sync import sync_source
from tests.unit._stream_inbox_matrix import double_for, sent_by_us, served
from tests.utils.mock_worker import MockDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


async def _recorded_reply(source) -> SourceItem:
    """The reply once it is on record — the double sees the post a step before ``send`` records it."""
    while not (rows := await sent_by_us(source)):
        await asyncio.sleep(0.02)
    (row,) = rows
    return row


@pytest.mark.long  # 4.6s: one real MockWorker turn waits the transcript's 2s settle
async def test_an_agent_on_an_open_channel_never_answers_the_echo_of_its_own_reply(worker, monkeypatch):
    with double_for("slack") as double:
        monkeypatch.setattr(DataDriver.loaded("slack").cls, "open_inbound", True)  # strangers are the point
        agent, source, server = await served("slack", double, monkeypatch, allowed=[])
        try:
            double.deliver("my order never arrived", sender=double.sender)
            await sync_source(source)
            reply = await asyncio.wait_for(_recorded_reply(source), 10)

            await sync_source(source)  # the channel's copy of our reply comes back, signed U1
            await asyncio.sleep(0.5)  # time for the loop to (wrongly) answer it
        finally:
            await server.stop()
            await agent.delete()

    echo = await SourceItem.get_one({"id": str(reply.id)})
    assert echo.author_external_id == "U1" and echo.sent_by_us, "the echo is the same row, still ours"
    assert worker.received_prompts == ["my order never arrived"], "the agent took its own reply as a customer's"
    assert len(double.sent()) == 1
