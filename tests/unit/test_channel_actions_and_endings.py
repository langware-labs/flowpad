"""Channel actions (a driver's ``Acting.actions`` run on a whole conversation), conversations that
end with a message (``MessageData.ends_conversation``), and the ``Link: rel="next"`` pager."""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from flow_sdk.app.actions import share_action
from flow_sdk.app.actions.repo_actions import _parse_next_page_from_link
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.conversation_channel import channel_spec
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.ingest.ingestor import ingest_item
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.schema.data_spec.channel_spec import ActionSpec
from flow_sdk.sources import Acting
from flow_sdk.sources.http import next_link, paginate
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.utils.serialization import iso_to_utc
from flow_sdk.stream_inbox.projection import project_source_item
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval
scoped = pytest.mark.usefixtures("fresh_user_scope")

PROVIDER = "chatacts"
DANA = "dana@chat.test"
APPROVE = ActionSpec(id="approve", label="Approve", icon_name="check", needs_text=True)
CLOSE = ActionSpec(id="close", label="Close", destructive=True, confirm="Close it?")


@contextmanager
def acting_provider():
    """The scripted channel, made ``Acting``: ``approve`` writes a message, ``close`` writes none."""
    with scripted_provider(PROVIDER, projected=True) as script:
        driver = DRIVERS.get_or_none(PROVIDER)
        acted: list = []

        async def act(self, conversation, action, text=""):
            acted.append((conversation.key, action, text))
            if action != "approve":
                return None
            return MessageItem(origin=self.origin("review-1"), data=MessageData(text=text, conversation=conversation))

        driver._cls = type("Acting_" + PROVIDER, (driver.cls,), {"actions": (APPROVE, CLOSE), "act": act})
        script.acted = acted
        yield script


async def _source() -> DataSource:
    me = f"{uuid.uuid4().hex[:8]}-me@chat.test"
    src = DataSource(name=f"chat {uuid.uuid4().hex[:8]}", provider=PROVIDER, account_key=me, config={"address": me})
    await src.save()
    return src


async def _land(src: DataSource, key: str, *, at: datetime | None = None, ends: bool = False) -> SourceItem:
    """One message from Dana in thread ``pr-7``, ingested and projected — no sync round."""
    origin = lambda k: CloudOrigin(kind=PROVIDER, namespace=src.account_key, key=k)  # noqa: E731
    data = MessageData(
        text=key, sender=UserProfile(origin=origin(DANA), address=DANA), conversation=origin("pr-7"),
        sent_at=at or datetime.now(timezone.utc), ends_conversation=ends,
    )
    outcome = await ingest_item(envelope_of(MessageItem(origin=origin(key), data=data), data_source_id=str(src.id), provider=PROVIDER))
    row = await SourceItem.get_one({"id": outcome.entity_id})
    await project_source_item(row, source=src, announce=False)
    return row


async def _chat(src: DataSource) -> Conversation:
    row = await _land(src, "m1")
    message = await FlowMessage.get_one({"source_item_id": str(row.id)})
    return await Conversation.get_one({"id": message.conversation_id})


async def _post(conversation_id: str, body: dict):
    async def data():
        return body

    info = SimpleNamespace(target_entity_typeid=SimpleNamespace(id=conversation_id), get_post_data=data)
    with patch.object(share_action, "get_current_request_info", return_value=info):
        return await share_action.conversation_act()


def test_the_channel_spec_lists_an_acting_drivers_actions_and_none_otherwise():
    with scripted_provider(PROVIDER, projected=True):
        plain = channel_spec(PROVIDER)
    with acting_provider():
        acting = channel_spec(PROVIDER)
    assert plain.actions == []
    assert acting.actions == [APPROVE, CLOSE]
    assert [a["id"] for a in acting.model_dump(mode="json")["actions"]] == ["approve", "close"]


@scoped
async def test_act_runs_the_drivers_action_and_records_its_message_as_ours_once():
    with acting_provider() as script:
        src = await _source()
        chat = await _chat(src)
        response = await _post(str(chat.id), {"action": "approve", "text": "LGTM"})
        assert response.status == "SUCCESS" and response.data["ok"] is True
        item = await SourceItem.get_one({"id": response.data["item_id"]})
        # The provider's echo of the same review lands on that row, not a second one.
        await _land(src, "review-1")
        rows = await SourceItem.get_all({"data_source_id": str(src.id), "external_id": "review-1"})
        closed = await _post(str(chat.id), {"action": "close"})
    assert script.acted == [("pr-7", "approve", "LGTM"), ("pr-7", "close", "")]
    assert item.sent_by_us
    assert [r.id for r in rows] == [item.id] and rows[0].sent_by_us
    assert closed.status == "SUCCESS" and closed.data == {"ok": True, "item_id": None}


@scoped
async def test_an_action_the_channel_does_not_have_or_not_in_this_state_fails_and_reaches_no_driver():
    with acting_provider() as script:
        src = await _source()
        chat = await _chat(src)
        unknown = await _post(str(chat.id), {"action": "merge"})
        await _land(src, "merged", ends=True)
        on_ended = await _post(str(chat.id), {"action": "approve"})
        gone = await _post(str(uuid.uuid4()), {"action": "approve"})
    # A refusal is a 4xx carrying the channel's words — a 500 reaches the person without them.
    assert (unknown.status_code, unknown.message) == (422, "no action merge on this channel")
    assert (on_ended.status_code, on_ended.message) == (422, "this action is not available on an ended conversation")
    assert gone.status_code == 404 and "no conversation" in gone.message
    assert script.acted == []


@scoped
async def test_an_ending_message_ends_the_conversation_and_a_later_one_reopens_it():
    t0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=3)
    with scripted_provider(PROVIDER, projected=True):
        src = await _source()
        chat = await _chat(src)
        read = lambda: Conversation.get_one({"id": str(chat.id)})  # noqa: E731
        await _land(src, "merged", at=t0 + timedelta(hours=1), ends=True)
        merged = await read()
        await _land(src, "old", at=t0 - timedelta(hours=1))
        backfill = await read()
        await _land(src, "reopened", at=t0 + timedelta(hours=2))
        reopened = await read()
    assert iso_to_utc(merged.ended_at) == t0 + timedelta(hours=1)
    assert merged.model_dump(mode="json")["ended_at"], "ended_at reaches the local wire"
    assert backfill.ended_at is not None, "a message older than the end does not reopen it"
    assert reopened.ended_at is None


def _pages(pages: dict[str, tuple[object, str]]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body, nxt = pages[request.url.path + ("?" + request.url.query.decode() if request.url.query else "")]
        headers = {"Link": f'<https://api.test{nxt}>; rel="next", <https://api.test/last>; rel="last"'} if nxt else {}
        return httpx.Response(200, json=body, headers=headers)

    return httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler))


async def test_paginate_follows_next_links_until_there_is_none():
    pages = {"/items?per_page=2": ([1, 2], "/items?page=2"), "/items?page=2": ([3], "")}
    async with _pages(pages) as http:
        got = [i async for i in paginate(http, "/items", params={"per_page": 2})]
    assert got == [1, 2, 3]


async def test_paginate_reads_a_keyed_list_and_stops_at_max_pages():
    pages = {"/runs": ({"check_runs": ["a"]}, "/runs?page=2"), "/runs?page=2": ({"check_runs": ["b"]}, "/runs?page=3")}
    async with _pages(pages) as http:
        got = [i async for i in paginate(http, "/runs", key="check_runs", max_pages=2)]
    assert got == ["a", "b"]


def test_next_link_and_the_repo_page_number_read_one_header():
    header = '<https://api.github.com/user/repos?page=3>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"'
    assert next_link({"link": header}) == "https://api.github.com/user/repos?page=3"
    assert next_link({"Link": '<https://x/y?page=9>; rel="last"'}) is None
    assert _parse_next_page_from_link(header) == 3 and _parse_next_page_from_link(None) is None


def test_acting_is_exported():
    assert Acting.__name__ == "Acting"


def test_a_rate_limit_is_transient_whatever_status_says_it():
    from flow_sdk.sources.errors import AccessDenied, SourceUnavailable
    from flow_sdk.sources.http import error_for_status

    assert isinstance(error_for_status(403, headers={"X-RateLimit-Remaining": "0"}), SourceUnavailable)
    assert isinstance(error_for_status(403, headers=httpx.Headers({"Retry-After": "30"})), SourceUnavailable)
    assert isinstance(error_for_status(429), SourceUnavailable)
    assert isinstance(error_for_status(403, headers={"X-RateLimit-Remaining": "12"}), AccessDenied)


async def test_paginate_sees_a_rate_limited_page_and_adds_per_page_kwargs():
    from flow_sdk.sources.errors import SourceUnavailable

    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-page"))
        if request.url.params.get("page") == "2":
            return httpx.Response(403, headers={"x-ratelimit-remaining": "0"})
        return httpx.Response(200, json=[1], headers={"Link": '<https://api.test/i?page=2>; rel="next"'})

    async with httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(SourceUnavailable):
            [i async for i in paginate(http, "/i", page_kwargs=lambda page, url: {"headers": {"x-page": str(page)}})]
    assert seen == ["0", "1"]
