"""The ``cloud_email`` data source: a hub-held mailbox in, SourceItems out.

Offline by construction: the source is handed a fake mailbox, and the application adapter is
proven against the real email-inbox driver with the hub seam patched. Three are about traps:

* the body is the hydrated ``text``, never the list call's ``preview`` — ``body`` is digested;
* the hub's ``after`` is EXCLUSIVE, so a message sharing the boundary second must not be dropped;
* a hub that is merely unreachable must not park the source, while a mailbox that is gone must.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.source_registry import asset_module
from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound, SourceUnavailable
from flow_sdk.sources.testing import Subject, checks_for

CloudEmailSource = asset_module("cloud_email").CloudEmailSource
AppMailbox = asset_module("cloud_email", "transport").AppMailbox

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

AGENT_ID = "11111111-1111-4111-8111-111111111111"
ADDRESS = "agent-7@inbox.flowpad.ai"
LIST_ITEM = {
    "message_id": "<abc@mail.example>", "thread_id": "t-1", "inbox_id": ADDRESS,
    "sender": {"address": "joe@example.com", "name": "Joe Example"}, "to": [{"address": ADDRESS, "name": None}],
    "subject": "Round trip", "preview": "Hello there, this is the tr…", "text": None, "html": None,
    "timestamp": "2026-08-04T08:28:47.206Z", "labels": ["received"], "in_reply_to": None,
}
FULL_TEXT = "Hello there, this is the truncated preview's full body, well past the cut."


def _at(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


class _Mailbox:
    """The mailbox a source is handed: an ascending listing with an exclusive ``after``, hydration
    per id, send and reply. Records every call."""

    def __init__(self, messages=None, *, fail_hydration=False):
        self.messages, self.calls, self.fail_hydration, self.sent = list(messages or []), [], fail_hydration, 0

    async def list_messages(self, agent_id, **filters):
        self.calls.append(("list", agent_id, filters))
        after = filters.get("after")
        rows = sorted((m for m in self.messages if not after or _at(m["timestamp"]) > _at(after)), key=lambda m: m["timestamp"])
        return {"messages": rows[: int(filters.get("limit") or 25)], "count": len(rows)}

    async def get_message(self, agent_id, message_id):
        self.calls.append(("get", agent_id, message_id))
        if self.fail_hydration:
            raise SourceUnavailable("boom")
        found = next((m for m in self.messages if m["message_id"] == message_id), None)
        if found is None:
            raise NotFound("no such message")
        return {**found, "text": found.get("text") or FULL_TEXT}

    async def send(self, agent_id, body):
        self.calls.append(("send", agent_id, body))
        return self._file(f"t-new-{self.sent + 1}", None)

    async def reply(self, agent_id, message_id, body):
        self.calls.append(("reply", agent_id, message_id, body))
        parent = next((m for m in self.messages if m["message_id"] == message_id), None)
        if parent is None:
            raise NotFound("no such message")
        return self._file(parent["thread_id"], message_id)

    def _file(self, thread, replied):
        self.sent += 1
        sent = {**LIST_ITEM, "message_id": f"<sent-{self.sent}@x>", "thread_id": thread, "in_reply_to": replied,
                "timestamp": f"2026-08-05T00:00:0{self.sent}.000Z"}
        self.messages.append(sent)
        return {"message_id": sent["message_id"], "thread_id": thread}


def _row(**config):
    return SimpleNamespace(id=f"ds-{uuid.uuid4().hex[:8]}", provider="cloud_email", name="Agent mail", account_key=ADDRESS,
                           account_identities=[ADDRESS], owner=None, config={"agent_id": AGENT_ID, "address": ADDRESS, **config})


def _view(state=None, window_start=None):
    return position(segment_key=AGENT_ID, prior=state or {}, window_start=window_start)


@pytest.fixture
def mailbox(monkeypatch):
    fake = _Mailbox([LIST_ITEM])
    monkeypatch.setattr(CloudEmailSource, "build", classmethod(lambda cls, binding: cls(binding, mailbox=fake)))
    return fake


@pytest.mark.parametrize("check", checks_for(CloudEmailSource), ids=str)
async def test_conformance(check):
    fake = _Mailbox([{**LIST_ITEM, "message_id": f"<m{n}@x>", "timestamp": f"2026-08-04T08:2{n}:00.000Z"} for n in (1, 2, 3)])
    binding = SourceBinding(config={"agent_id": AGENT_ID, "address": ADDRESS})
    probe = CloudEmailSource(binding, mailbox=fake)
    await check.run(Subject(
        source=lambda: CloudEmailSource(binding, mailbox=fake),
        seeded=tuple(probe.origin(f"<m{n}@x>") for n in (1, 2, 3)),
        conversation=probe.origin(CloudEmailSource.thread_key(AGENT_ID, "t-1")),
        recipient=UserProfile(origin=probe.origin("joe@example.com"), address="joe@example.com"),
    ))


class TestTheSource:
    def test_it_is_registered_and_its_channel_is_the_medium(self):
        driver = source_type("cloud_email")
        assert driver is not None and driver.channel_for(_row()) == "email", "naming the transport would fork every thread"

    async def test_the_segment_is_keyed_on_the_agent_not_the_address(self, mailbox):
        (segment,) = await driver_segments(_row())
        assert (segment.key, segment.label) == (AGENT_ID, ADDRESS)

    async def test_an_owner_bound_mailbox_resolves_its_agent_from_the_owner(self, mailbox):
        row = _row(agent_id="")
        row.owner = SimpleNamespace(type="agent", id=AGENT_ID)
        (segment,) = await driver_segments(row)
        assert segment.key == AGENT_ID

    async def test_a_source_without_an_agent_cannot_poll(self, mailbox):
        with pytest.raises(Exception) as caught:
            await source_type("cloud_email").traverse(_row(agent_id=""), _view())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


async def driver_segments(row):
    return await source_type("cloud_email").segments(row)


class TestMapping:
    async def test_a_hub_email_becomes_a_source_item(self, mailbox):
        (item,) = (await source_type("cloud_email").traverse(_row(), _view())).items
        assert item.external_id == "<abc@mail.example>", "the RFC id, brackets intact"
        assert item.thread_key == f"{AGENT_ID}:t-1", "scoped to the mailbox, never the bare provider id"
        assert (item.name, item.kind, item.segment_key, item.reply_to_external_id) == ("Round trip", "content.message.email", AGENT_ID, None)
        assert item.occurred_at == "2026-08-04T08:28:47.206000+00:00"

    async def test_the_sender_arrives_structured_and_is_not_re_parsed(self, mailbox):
        (item,) = (await source_type("cloud_email").traverse(_row(), _view())).items
        assert (item.author_external_id, item.author_display) == ("joe@example.com", "Joe Example")

    async def test_the_body_is_the_hydrated_text_never_the_preview(self, mailbox):
        (item,) = (await source_type("cloud_email").traverse(_row(), _view())).items
        assert item.body == FULL_TEXT and item.body != LIST_ITEM["preview"]


class TestHydration:
    async def test_it_does_not_filter_to_received(self, mailbox):
        await source_type("cloud_email").traverse(_row(), _view())
        assert "labels" not in mailbox.calls[0][2]

    async def test_a_hydration_failure_keeps_the_cursor_put(self, mailbox):
        mailbox.fail_hydration = True
        result = await source_type("cloud_email").traverse(_row(), _view())
        assert result.items == [] and result.cursor is None, "the cursor moved past a message never read"


class TestCursor:
    async def test_it_advances_and_records_the_boundary(self, mailbox):
        result = await source_type("cloud_email").traverse(_row(), _view())
        assert result.cursor == CloudEmailSource.resume_at(LIST_ITEM["timestamp"], [LIST_ITEM["message_id"]])
        assert result.high_water.startswith("2026-08-04T08:28:47")

    async def test_the_after_parameter_is_nudged_behind_the_floor(self, mailbox):
        state = {"cursor": CloudEmailSource.resume_at(LIST_ITEM["timestamp"], [LIST_ITEM["message_id"]])}
        await source_type("cloud_email").traverse(_row(), _view(state))
        filters = mailbox.calls[0][2]
        assert _at(filters["after"]) < _at(LIST_ITEM["timestamp"]) and filters["ascending"] == "true"

    async def test_a_legacy_watermark_is_adopted(self, mailbox):
        result = await source_type("cloud_email").traverse(_row(), _view({"high_water": LIST_ITEM["timestamp"], "boundary_ids": [LIST_ITEM["message_id"]]}))
        assert result.items == [] and result.unchanged is True

    async def test_a_message_already_seen_at_the_boundary_is_not_re_ingested(self, mailbox):
        state = {"cursor": CloudEmailSource.resume_at(LIST_ITEM["timestamp"], [LIST_ITEM["message_id"]])}
        result = await source_type("cloud_email").traverse(_row(), _view(state))
        assert result.items == [] and result.unchanged is True

    async def test_a_second_message_in_the_same_second_still_arrives(self, mailbox):
        mailbox.messages.append({**LIST_ITEM, "message_id": "<def@mail.example>", "subject": "Sibling"})
        state = {"cursor": CloudEmailSource.resume_at(LIST_ITEM["timestamp"], [LIST_ITEM["message_id"]])}
        result = await source_type("cloud_email").traverse(_row(), _view(state))
        assert [i.external_id for i in result.items] == ["<def@mail.example>"]
        assert result.cursor == CloudEmailSource.resume_at(LIST_ITEM["timestamp"], ["<abc@mail.example>", "<def@mail.example>"])

    async def test_a_burst_sharing_a_second_does_not_stall_a_small_page(self):
        burst = [{**LIST_ITEM, "message_id": f"<b{n}@x>"} for n in range(3)]
        source = CloudEmailSource(SourceBinding(config={"agent_id": AGENT_ID}), mailbox=_Mailbox(burst))
        async with source:
            assert len([item async for item in source.iterate(page_size=1)]) == 3

    async def test_an_empty_page_is_unchanged(self, mailbox):
        mailbox.messages = []
        result = await source_type("cloud_email").traverse(_row(), _view())
        assert result.items == [] and result.unchanged is True


class TestTheAppMailbox:
    """The adapter over the real email-inbox driver: the hub seam is the only thing patched."""

    @staticmethod
    def _hub(monkeypatch, *, error=None, calls=None):
        async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, *, params=None, **_):
            if calls is not None:
                calls.append((entity_id, action, sub_path))
            if error is not None:
                raise error
            return {"messages": [LIST_ITEM], "count": 1} if sub_path == "messages" else {**LIST_ITEM, "text": FULL_TEXT}

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

    async def test_it_lists_by_agent_and_hydrates_with_an_encoded_id(self, monkeypatch):
        calls: list = []
        self._hub(monkeypatch, calls=calls)
        await AppMailbox().list_messages(AGENT_ID, limit="25", ascending="true")
        await AppMailbox().get_message(AGENT_ID, "<abc@mail.example>")
        assert calls[0] == (AGENT_ID, "email_inbox", "messages")
        assert calls[1][2] == "messages/%3Cabc%40mail.example%3E", "a Message-ID carries brackets and rides in the path"

    @pytest.mark.parametrize("error,health", [
        (HubError(404, "agent has no inbox"), SourceHealth.CONFIG_ERROR),
        (HubError(401, "unauthorized"), SourceHealth.CONFIG_ERROR),
        (HubError(0, "hub not configured"), SourceHealth.CONFIG_ERROR),
        (HubError(0, "connection reset"), SourceHealth.TRANSIENT_ERROR),
        (HubError(503, "email inbox capability is disabled"), SourceHealth.TRANSIENT_ERROR),
        (HubError(429, "slow down"), SourceHealth.TRANSIENT_ERROR),
    ])
    async def test_a_hub_failure_maps_to_the_right_health(self, monkeypatch, error, health):
        self._hub(monkeypatch, error=error)
        with pytest.raises(Exception) as caught:
            await AppMailbox().list_messages(AGENT_ID, limit="25")
        assert classify(caught.value)[0] is health


class TestTheDigestGateHolds:
    async def test_re_delivering_the_same_message_writes_nothing(self, mailbox):
        row = _row()
        first = await ingest_items((await source_type("cloud_email").traverse(row, _view())).items)
        assert first.created == 1
        second = await ingest_items((await source_type("cloud_email").traverse(row, _view())).items)
        assert (second.unchanged, second.created, second.updated) == (1, 0, 0), "the mapping is not deterministic"
