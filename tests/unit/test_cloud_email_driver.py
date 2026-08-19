"""The cloud-email driver: hub payload in, SourceItem out.

Offline by construction — the hub seam is monkeypatched, so this runs with no
network, no hub and no credentials. The mechanism is the one
``test_hub_secret_driver.py`` uses (patch the module-qualified symbol the driver
imports lazily) applied to the source/cursor fakes ``test_agentmail_driver.py``
uses.

Three of these tests are about traps rather than plumbing, and each is the trap
that would otherwise be found in production:

* the body must be the hydrated ``text``, never the list call's ``preview`` —
  ``body`` is digested, so upgrading it later rewrites every record;
* the ``after`` filter is EXCLUSIVE hub-side, so a message sharing the boundary
  second is dropped rather than re-delivered — loss, which no gate recovers;
* a hub that is merely unreachable must not park the source, while a mailbox
  that no longer exists must.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.ingest.driver import get_driver
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.ingest.ingestor import ingest_items

AGENT_ID = "11111111-1111-4111-8111-111111111111"
ADDRESS = "agent-7@inbox.flowpad.ai"

#: A list result, in the hub's own `model_dump()` shape: `sender` is a
#: structured EmailAddress, `text` is absent, `preview` stands in for it, and
#: `message_id` keeps its angle brackets.
LIST_ITEM = {
    "message_id": "<abc@mail.example>",
    "thread_id": "t-1",
    "inbox_id": ADDRESS,
    "sender": {"address": "joe@example.com", "name": "Joe Example"},
    "to": [{"address": ADDRESS, "name": None}],
    "subject": "Round trip",
    "preview": "Hello there, this is the tr…",
    "text": None,
    "html": None,
    "timestamp": "2026-08-04T08:28:47.206Z",
    "labels": ["received"],
    "in_reply_to": None,
}

#: What `messages/<id>` adds: the actual body.
FULL_TEXT = "Hello there, this is the truncated preview's full body, well past the cut."
FULL_ITEM = {**LIST_ITEM, "text": FULL_TEXT}


def _source(**config) -> SimpleNamespace:
    base = {"agent_id": AGENT_ID, "address": ADDRESS}
    base.update(config)
    return SimpleNamespace(id=f"ds-{uuid.uuid4().hex[:8]}", name="Agent mail", config=base)


def _cursor(state=None, window_start=None) -> SimpleNamespace:
    return SimpleNamespace(
        segment_key=AGENT_ID, state=state or {}, window_start=window_start, first_run=not state
    )


def _hub(monkeypatch, *, pages=None, error=None, calls=None):
    """Fake the one hub seam the driver uses, recording every call.

    Hydration answers PER ID — the list entry for the requested message plus its
    `text`. A fake that returned one canned body for every id would hide a
    mismatch between the message asked for and the message mapped.
    """
    page = pages if pages is not None else {"messages": [], "count": 0}
    by_id = {m["message_id"]: {**m, "text": FULL_TEXT} for m in page.get("messages", [])}

    async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, *, params=None, **_):
        if calls is not None:
            calls.append({"entity_id": entity_id, "action": action, "sub_path": sub_path, "params": params or {}})
        if error is not None:
            raise error
        if sub_path == "messages":
            return page
        wanted = unquote((sub_path or "").split("/", 1)[-1])
        return by_id.get(wanted, {**LIST_ITEM, "text": FULL_TEXT})

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)


class TestItIsAPluggableDriver:
    def test_it_is_registered(self):
        """Forgetting the `register_driver` line is silent: the source just
        parks on `unknown_provider` at its first poll."""
        import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers

        assert get_driver("cloud_email") is not None

    def test_its_record_kind_reaches_the_inbox(self):
        """The projection accepts `content.message.*` and NOTHING else, and a
        wrong kind is dropped silently rather than raising."""
        assert CloudEmailDriver.record_kind.startswith("content.message.")

    def test_the_channel_is_the_medium_not_the_transport(self):
        """The channel is half the deterministic thread id, so `cloud_email`
        here would fork every thread from any other transport on this mailbox."""
        assert CloudEmailDriver().channel_for(_source()) == "email"

    def test_the_stream_is_keyed_on_the_agent_not_the_address(self):
        """`segment_key` is a third of a SourceItem's natural key. The address is
        allocated and can change; the agent id cannot."""
        stream = CloudEmailDriver().segments(_source())[0]
        assert stream.key == AGENT_ID
        assert stream.label == ADDRESS, "the address is still what a human reads"


class TestMapping:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_hub_email_becomes_a_source_item(self, monkeypatch):
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})
        src = _source()

        item = (await CloudEmailDriver().fetch(src, _cursor())).items[0]

        assert item.external_id == "<abc@mail.example>", "the RFC id, brackets intact"
        assert item.thread_key == "t-1"
        assert item.title == "Round trip"
        assert item.occurred_at == "2026-08-04T08:28:47.206Z"
        assert item.kind == "content.message.email"
        assert item.segment_key == AGENT_ID
        assert item.reply_to_external_id is None

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_the_sender_arrives_structured_and_is_not_re_parsed(self, monkeypatch):
        """The hub normalizes `sender` into {address, name}. Treating it as a
        `"Name <addr>"` header string — the shape the AgentMail driver has to
        parse — would put a dict's repr in the byline."""
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})

        item = (await CloudEmailDriver().fetch(_source(), _cursor())).items[0]

        assert item.author_external_id == "joe@example.com"
        assert item.author_display == "Joe Example"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_the_body_is_the_hydrated_text_never_the_preview(self, monkeypatch):
        """THE correctness assertion. `body` is in DIGESTED_FIELDS, so a record
        ingested with the preview and later upgraded to the text flips its digest
        — rewriting the row, re-indexing it and re-firing every trigger on mail
        that never changed."""
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})

        item = (await CloudEmailDriver().fetch(_source(), _cursor())).items[0]

        assert item.body == FULL_TEXT
        assert item.body != LIST_ITEM["preview"]


class TestHydration:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_it_fetches_the_full_message_and_encodes_the_id(self, monkeypatch):
        """A Message-ID carries angle brackets and rides in the URL path;
        `hub_graph_url` does no quoting. Unencoded, the path is malformed — the
        same trap the AgentMail driver's test pins."""
        calls: list[dict] = []
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1}, calls=calls)

        await CloudEmailDriver().fetch(_source(), _cursor())

        listed, hydrated = calls[0], calls[1]
        assert (listed["entity_id"], listed["action"], listed["sub_path"]) == (
            AGENT_ID, "email_inbox", "messages",
        )
        assert hydrated["sub_path"] == "messages/%3Cabc%40mail.example%3E"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_it_does_not_filter_to_received(self, monkeypatch):
        """Our own sent copies must come back: `send` reports `recorded=False`
        on the promise that the next poll ingests them. Filtering to `received`
        makes every reply the user sends vanish from its own thread."""
        calls: list[dict] = []
        _hub(monkeypatch, pages={"messages": [], "count": 0}, calls=calls)

        await CloudEmailDriver().fetch(_source(), _cursor())

        assert "labels" not in calls[0]["params"]

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_hydration_failure_keeps_the_cursor_put(self, monkeypatch):
        """Advancing past a message we failed to read loses it for good. The
        next tick is the retry — not a loop here."""
        state = {"messages": [LIST_ITEM], "count": 1}

        async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, *, params=None, **_):
            if sub_path == "messages":
                return state
            raise HubError(500, "boom")

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

        result = await CloudEmailDriver().fetch(_source(), _cursor())

        assert result.items == []
        assert result.next_state.get("high_water") in (None, ""), (
            "the cursor moved past a message that was never read"
        )


class TestCursor:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_it_advances_and_records_the_boundary(self, monkeypatch):
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})

        result = await CloudEmailDriver().fetch(_source(), _cursor())

        assert result.next_state["high_water"] == "2026-08-04T08:28:47.206Z"
        assert result.next_state["boundary_ids"] == ["<abc@mail.example>"]
        assert result.high_water == "2026-08-04T08:28:47.206Z"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_the_after_parameter_is_nudged_behind_the_floor(self, monkeypatch):
        """The hub rejects `timestamp <= after`. Sending the floor itself drops
        any message sharing that second — permanently. Over-fetching is the safe
        direction; the local filter and the digest gate absorb the overlap."""
        calls: list[dict] = []
        _hub(monkeypatch, pages={"messages": [], "count": 0}, calls=calls)
        floor = "2026-08-04T08:28:47.206000+00:00"

        await CloudEmailDriver().fetch(_source(), _cursor(state={"high_water": floor}))

        sent = calls[0]["params"]["after"]
        assert sent < floor, f"after={sent} is not behind the floor {floor}"
        assert calls[0]["params"]["ascending"] == "true"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_message_already_seen_at_the_boundary_is_not_re_ingested(self, monkeypatch):
        """The over-fetch re-reads the boundary second; `boundary_ids` is what
        stops it costing a re-ingest."""
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})
        state = {
            "high_water": LIST_ITEM["timestamp"],
            "boundary_ids": [LIST_ITEM["message_id"]],
        }

        result = await CloudEmailDriver().fetch(_source(), _cursor(state=state))

        assert result.items == []
        assert result.unchanged is True

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_second_message_in_the_same_second_still_arrives(self, monkeypatch):
        """The loss this design exists to prevent: two messages stamped
        identically, one already ingested. The other must NOT be skipped."""
        sibling = {**LIST_ITEM, "message_id": "<def@mail.example>", "subject": "Sibling"}
        _hub(monkeypatch, pages={"messages": [LIST_ITEM, sibling], "count": 2})
        state = {
            "high_water": LIST_ITEM["timestamp"],
            "boundary_ids": [LIST_ITEM["message_id"]],
        }

        result = await CloudEmailDriver().fetch(_source(), _cursor(state=state))

        assert [i.external_id for i in result.items] == ["<def@mail.example>"]
        assert set(result.next_state["boundary_ids"]) == {
            "<abc@mail.example>",
            "<def@mail.example>",
        }

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_an_empty_page_is_unchanged(self, monkeypatch):
        _hub(monkeypatch, pages={"messages": [], "count": 0})

        result = await CloudEmailDriver().fetch(_source(), _cursor())

        assert result.items == [] and result.unchanged is True


class TestErrorClassification:
    """Which failures park a source, and which merely wait for the next tick.

    The fakes still raise `HubError` because that is what the hub transport
    raises; the mailbox driver translates it into the family's `EmailInboxError`
    on the way out, so these also prove that translation is wired.

    `hub_get` cannot tell these apart — it collapses every one to None — which is
    the whole reason the mailbox driver goes through `hub_get_or_raise`.
    """

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    @pytest.mark.parametrize(
        "error,health,code",
        [
            (HubError(404, "agent has no inbox"), SourceHealth.CONFIG_ERROR, "no_inbox"),
            (HubError(401, "unauthorized"), SourceHealth.CONFIG_ERROR, "unauthorized"),
            (HubError(0, "hub not configured"), SourceHealth.CONFIG_ERROR, "mailbox_not_configured"),
            (HubError(0, "connection reset"), SourceHealth.TRANSIENT_ERROR, "network"),
            (HubError(503, "email inbox capability is disabled"), SourceHealth.TRANSIENT_ERROR, "server_error"),
            (HubError(429, "slow down"), SourceHealth.TRANSIENT_ERROR, "rate_limited"),
        ],
    )
    async def test_a_hub_failure_maps_to_the_right_health(self, monkeypatch, error, health, code):
        _hub(monkeypatch, error=error)

        with pytest.raises(SourceError) as caught:
            await CloudEmailDriver().fetch(_source(), _cursor())

        assert caught.value.health is health
        assert caught.value.code == code

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_source_without_an_agent_cannot_poll(self, monkeypatch):
        """`agent_id` is the only load-bearing config key — the hub addresses a
        mailbox by agent, never by address."""
        _hub(monkeypatch, pages={"messages": [], "count": 0})

        with pytest.raises(SourceError) as caught:
            await CloudEmailDriver().fetch(_source(agent_id=""), _cursor())

        assert caught.value.health is SourceHealth.CONFIG_ERROR
        assert caught.value.code == "no_agent"


class TestTheDigestGateHolds:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_re_delivering_the_same_message_writes_nothing(self, monkeypatch):
        """The mapper has to be a pure function of the payload. If any part of it
        varies per call, every poll rewrites the row, re-indexes it and re-fires
        its triggers — the failure `IngestReport.unchanged` exists to expose."""
        _hub(monkeypatch, pages={"messages": [LIST_ITEM], "count": 1})
        src = _source()

        first = await ingest_items((await CloudEmailDriver().fetch(src, _cursor())).items)
        assert first.created == 1

        second = await ingest_items((await CloudEmailDriver().fetch(src, _cursor())).items)
        assert second.unchanged == 1, "a re-read rewrote the row — the mapping is not deterministic"
        assert second.created == 0 and second.updated == 0
