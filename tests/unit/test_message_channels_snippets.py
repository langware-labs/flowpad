"""``docs/snippets/message-channels.md``, run as written against a scripted channel.

One reader session, top to bottom: §1 sends files quoting a chosen message; §2 is the agent loop,
driven by the mock worker until it has reacted, answered and reacted again; §3 reads a photo that
arrived; §4 reacts from anywhere, and the emoji the channel cannot show is refused.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.sync import sync_source
from flow_sdk.sources.errors import Rejected
from flow_sdk.stream_inbox.projection import project_source_item
from tests.utils.fake_source import scripted_provider
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fence_under, run_fence, run_fence_until

pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

DOC = "message-channels.md"
PROVIDER = "chatsnip"
CUSTOMER = "dana@chat.test"


async def _conversation(script, address: str) -> str:
    """A chat with three messages from the customer, projected — what §1 answers in."""
    src = DataSource(name=f"snip {uuid.uuid4().hex[:6]}", provider=PROVIDER, account_key=address, config={"address": address})
    await src.save()
    for n in (1, 2, 3):
        script.push({"external_id": f"q{n}", "author": CUSTOMER, "thread_key": "t1", "body": f"question {n}", "occurred_at": f"2026-09-27T10:0{n}:00+00:00"})
        await sync_source(src)
        row = await SourceItem.get_one({"data_source_id": str(src.id), "external_id": f"q{n}"})
        await project_source_item(row, source=src, announce=False)
    fm = await FlowMessage.get_one({"source_item_id": str(row.id)})
    return str(fm.conversation_id)


@pytest.mark.long  # 1.30s: the §2 turn runs on the mock worker, which waits out its transcript's settle window
async def test_the_page_runs_as_written(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "invoice.pdf").write_bytes(b"%PDF-1.4")
    (tmp_path / "site.jpg").write_bytes(b"\xff\xd8site")
    (tmp_path / "note.ogg").write_bytes(b"OggS")
    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)
    page = doc(DOC)
    address = f"{uuid.uuid4().hex[:8]}@chat.test"

    with scripted_provider(PROVIDER, projected=True) as script:
        ns = {"CONVERSATION_ID": await _conversation(script, address), "ADDRESS": address, "PROVIDER": PROVIDER, "CUSTOMER": CUSTOMER}

        # §1 — files, quoting the chosen message.
        await run_fence(fence_under(page, "1."), ns, filename=f"{DOC} §1")
        invoice, photo, note = script.sent
        assert invoice["in_reply_to"] == "q1" and invoice["files"][0]["caption"] == "Here's the invoice and the site photo."
        assert photo["in_reply_to"] == "" and [f["name"] for f in photo["files"]] == ["site.jpg"]
        assert note["files"][0]["as_"] == "voice"

        # §2 — the agent loop reacts, answers, reacts again.
        script.push({"external_id": "p1", "author": CUSTOMER, "thread_key": "t2", "body": "is this crack bad?"})
        answered = asyncio.Event()

        async def watch():
            while not any(r[1] == "✅" for r in script.reacted):
                await asyncio.sleep(0.02)
            answered.set()

        watcher = asyncio.create_task(watch())
        try:
            await run_fence_until(fence_under(page, "2."), ns, answered, filename=f"{DOC} §2")
        finally:
            watcher.cancel()
        assert [(key, emoji) for key, emoji, _ in script.reacted] == [("p1", "👀"), ("p1", "✅")]
        assert script.sent[-1]["text"].startswith("Mock reply")

        # §3 — a photo that arrived is on this machine already.
        script.push({
            "external_id": "p2", "author": CUSTOMER, "thread_key": "t2", "body": "another angle", "reply_to_external_id": "p1",
            "files": [{"key": "img-2", "name": "IMG_0413.jpg", "media_type": "image/jpeg", "as_": "image", "caption": "the crack", "bytes": b"\xff\xd8two"}],
        })
        await run_fence(fence_under(page, "3."), ns, filename=f"{DOC} §3")
        (f,) = ns["m"].files
        assert (f.name, f.as_, f.caption) == ("IMG_0413.jpg", "image", "the crack") and open(f.path, "rb").read() == b"\xff\xd8two"
        assert ns["m"].reply_to.external_id == "p1"

        # §4 — react from anywhere; the channel says what it can do; an emoji it cannot show is refused.
        await run_fence(fence_under(page, "4.", nth=0), ns, filename=f"{DOC} §4")
        (put, took) = script.reacted[-2:]
        assert put[1:] == ("👍", False) and took == (put[0], "", True), "on the newest message, then all of ours back"
        spec = (await Conversation.get_one({"id": ns["CONVERSATION_ID"]})).channel_spec
        assert (spec.quotes, spec.reacts, spec.accepts_attachments) == (True, True, True)
        await run_fence(fence_under(page, "4.", nth=1), ns, filename=f"{DOC} §4 refusal", raises=Rejected)
