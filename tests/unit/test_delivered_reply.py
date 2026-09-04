"""``Delivered.reply()`` — the piggybacked ack, and the one thing it must never do: send twice.

Every path here is a crash window: before the send, between send and record, between record
and ack. The provider is a ``ScriptedDriver`` that, like four of the five real senders, does
NOT record its own sent copy — so the redelivery lookup has to work the eventually-consistent
way it does in production.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import EmailMessageSpec, Inbox, workflow
from flow_sdk.builtin.consumer_position import ConsumerPosition
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver import SendOutcome, SendStatus
from flow_sdk.tags import on_tag
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ME = "me@scripted.test"


def _name() -> str:
    return f"w-{mint_uuid()}"


async def _inbox(addr: str) -> tuple[Inbox, DataSource]:
    """A source that knows its own address, so a sent copy is recognised as ours."""
    src = DataSource(name="pre", provider="scripted", config={"inbox": addr}, account_key=ME)
    await src.save()
    return Inbox(addr, provider="scripted"), src


async def _one(inbox: Inbox):
    agen = inbox.listen(poll_every=0)
    try:
        return await agen.__anext__()
    finally:
        await agen.aclose()


# ── the happy path ───────────────────────────────────────────────────────────


async def test_reply_sends_records_then_acks():
    with scripted_provider("scripted") as driver:
        inbox, src = await _inbox(f"{mint_uuid()}@x")
        driver.push({"body": "hi", "author": "alice@example.com", "thread_key": "t1"})
        async with workflow(_name()) as _:
            m = await _one(inbox)
            outcome = await m.reply(EmailMessageSpec.reply_to(m, body="hello back"))

    assert outcome.external_id and len(driver.sent) == 1
    assert driver.sent[0]["to"] == "alice@example.com" and driver.sent[0]["text"] == "hello back"
    assert m.acked
    position = (await ConsumerPosition.get_all({"data_source_id": str(src.id)}))[0]
    assert position.replying_to == "" and position.replied_external_id == ""


async def test_a_drafted_outcome_acks():
    """A draft reached nobody, but it is a real outcome — not a failure to retry."""
    with scripted_provider("scripted") as driver:
        inbox, _ = await _inbox(f"{mint_uuid()}@x")
        driver.push({"body": "hi"})

        async def draft(source, **kw):
            return SendOutcome(external_id="", status=SendStatus.DRAFTED, recorded=False)

        driver.send = draft
        async with workflow(_name()):
            m = await _one(inbox)
            outcome = await m.reply(EmailMessageSpec.reply_to(m, body="x"))
    assert outcome.drafted and m.acked


# ── the crash windows ────────────────────────────────────────────────────────


async def test_a_crash_between_send_and_record_never_resends_when_the_copy_turns_up():
    with scripted_provider("scripted") as driver:
        inbox, src = await _inbox(f"{mint_uuid()}@x")
        name = _name()
        driver.push({"body": "hi", "external_id": "<m1>", "thread_key": "t1"})
        async with workflow(name):
            m = await _one(inbox)                       # handed out; we "send" and die
            position = await ConsumerPosition.ensure_for(name, str(src.id))
            position.replying_to = str(m._row.id)
            from datetime import datetime, timezone
            position.replying_started_at = datetime.now(timezone.utc)
            await position.commit()
        # The provider did send it; its next page carries our own copy.
        driver.push({"body": "hello back", "author": ME, "thread_key": "t1", "reply_to_external_id": "<m1>"})

        async with workflow(name):                      # restart
            again = await _one(inbox)
            assert again.redelivered
            outcome = await again.reply(EmailMessageSpec.reply_to(again, body="hello back"))
    assert driver.sent == [], "the copy was found — nothing may be sent again"
    assert outcome is not None and outcome.recorded and again.acked


async def test_a_crash_with_no_copy_to_be_found_acks_with_needs_review_and_says_so():
    seen: list[dict] = []
    off = on_tag("ingest.*.reply.needs_review", lambda e: seen.append(e.data))
    try:
        with scripted_provider("scripted") as driver:
            inbox, src = await _inbox(f"{mint_uuid()}@x")
            name = _name()
            driver.push({"body": "hi", "thread_key": "t1"})
            async with workflow(name):
                m = await _one(inbox)
                position = await ConsumerPosition.ensure_for(name, str(src.id))
                position.replying_to = str(m._row.id)
                from datetime import datetime, timezone
                position.replying_started_at = datetime.now(timezone.utc)
                await position.commit()
            async with workflow(name):
                again = await _one(inbox)
                outcome = await again.reply(EmailMessageSpec.reply_to(again, body="x"))
    finally:
        off()
    assert outcome is None and driver.sent == []
    assert again.acked
    position = (await ConsumerPosition.get_all({"data_source_id": str(src.id)}))[0]
    assert position.needs_review == [str(m._row.id)]
    assert seen and seen[0]["item_id"] == str(m._row.id) and seen[0]["consumer"] == name


async def test_a_crash_between_record_and_ack_only_owes_the_ack():
    with scripted_provider("scripted") as driver:
        inbox, src = await _inbox(f"{mint_uuid()}@x")
        name = _name()
        driver.push({"body": "hi"})
        async with workflow(name):
            m = await _one(inbox)
            position = await ConsumerPosition.ensure_for(name, str(src.id))
            position.replying_to = str(m._row.id)
            position.replied_external_id = "<sent-once>"
            await position.commit()
        async with workflow(name):
            again = await _one(inbox)
            outcome = await again.reply(EmailMessageSpec.reply_to(again, body="x"))
    assert driver.sent == [] and outcome.external_id == "<sent-once>" and again.acked


async def test_a_send_that_raises_leaves_the_intent_so_the_retry_cannot_double():
    with scripted_provider("scripted") as driver:
        inbox, src = await _inbox(f"{mint_uuid()}@x")
        name = _name()
        driver.push({"body": "hi"})

        async def explode(source, **kw):
            raise ValueError("the provider hung up mid-send")

        real_send, driver.send = driver.send, explode
        async with workflow(name):
            m = await _one(inbox)
            with pytest.raises(ValueError):
                await m.reply(EmailMessageSpec.reply_to(m, body="x"))
        position = (await ConsumerPosition.get_all({"data_source_id": str(src.id)}))[0]
        assert position.replying_to == str(m._row.id), "intent survives the failure"

        driver.send = real_send
        async with workflow(name):
            again = await _one(inbox)
            assert again.redelivered
            outcome = await again.reply(EmailMessageSpec.reply_to(again, body="x"))
    assert outcome is None and driver.sent == [], "may or may not have sent: never resend"
    assert again.acked


async def test_the_fallback_lookup_matches_a_thread_when_the_driver_stamps_no_reply_id():
    """Slack-shaped: the sent copy carries the thread, not the replied-to id."""
    with scripted_provider("scripted") as driver:
        inbox, src = await _inbox(f"{mint_uuid()}@x")
        name = _name()
        driver.push({"body": "hi", "thread_key": "t9"})
        async with workflow(name):
            m = await _one(inbox)
            position = await ConsumerPosition.ensure_for(name, str(src.id))
            position.replying_to = str(m._row.id)
            from datetime import datetime, timedelta, timezone
            position.replying_started_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await position.commit()
        driver.push({"body": "reply", "author": ME, "thread_key": "t9"})   # no reply_to_external_id
        async with workflow(name):
            again = await _one(inbox)
            outcome = await again.reply(EmailMessageSpec.reply_to(again, body="reply"))
    assert driver.sent == [] and outcome is not None and outcome.recorded
