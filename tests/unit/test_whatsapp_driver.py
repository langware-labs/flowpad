"""The WhatsApp driver, and the webhook translation that feeds it.

WhatsApp inverts the assumption every other message source is built on: there
is no endpoint that lists messages, so the records are produced by a webhook
POST rather than by `fetch`. That makes the translation — Meta's envelope to
`SourceItemSpec` — the load-bearing part, and it is a pure function precisely so
these tests need no socket at all.

The send leg still talks HTTP, so that half uses the same loopback server the
other driver tests do.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers import whatsapp as whatsapp_module
from flow_sdk.ingest.drivers.whatsapp import WhatsAppDriver, items_from_webhook
from tests.unit._ingest_helpers import local_http_server

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

PHONE_ID = "123456789012345"
WA_ID = "972501234567"


def _source(**config) -> DataSource:
    return DataSource(
        provider="whatsapp",
        name="WhatsApp test",
        config={"phone_number_id": PHONE_ID, "access_token": "EAAG-test", **config},
    )


def _webhook(*messages, contacts=None, statuses=None, phone_number_id: str = PHONE_ID) -> dict:
    """Meta's envelope, in the shape it actually posts."""
    value: dict = {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15550001111", "phone_number_id": phone_number_id},
    }
    if contacts is not None:
        value["contacts"] = contacts
    if messages:
        value["messages"] = list(messages)
    if statuses is not None:
        value["statuses"] = statuses
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": value}]}],
    }


def _text(message_id: str, body: str, *, ts: str = "1789000000", **extra) -> dict:
    return {
        "id": message_id,
        "from": WA_ID,
        "timestamp": ts,
        "type": "text",
        "text": {"body": body},
        **extra,
    }


# ── the translation ──────────────────────────────────────────────────────────


async def test_a_message_becomes_a_record_addressed_to_its_sender():
    """The conversation IS the pair, so the person is the thread. WhatsApp has
    no thread handle to derive one from, and inventing a per-message one would
    put every turn in a conversation of its own."""
    (item,) = items_from_webhook(
        _source(), _webhook(_text("wamid.AAA", "hello"), contacts=[{"wa_id": WA_ID, "profile": {"name": "Dana"}}])
    )

    assert item.external_id == "wamid.AAA"
    assert item.body == "hello"
    assert item.thread_key == WA_ID
    assert item.author_external_id == WA_ID
    assert item.author_display == "Dana"
    assert item.occurred_at.startswith("2026-")


async def test_delivery_receipts_are_not_messages():
    """`statuses` is our own outbound being acknowledged — sent, delivered,
    read. Real events that nobody wrote, and each one would land in the inbox
    as a line from no one."""
    payload = _webhook(statuses=[{"id": "wamid.OUT", "status": "delivered", "recipient_id": WA_ID}])

    assert items_from_webhook(_source(), payload) == []


async def test_a_tapped_button_is_a_turn_in_the_conversation():
    """A person answering a prompt taps rather than types, and it arrives as
    `interactive` instead of `text`. Dropping those would make the conversation
    lose exactly the turns the agent's own question invited."""
    tapped = {
        "id": "wamid.BBB",
        "from": WA_ID,
        "timestamp": "1789000001",
        "type": "interactive",
        "interactive": {"type": "button_reply", "button_reply": {"id": "yes", "title": "Yes please"}},
    }

    (item,) = items_from_webhook(_source(), _webhook(tapped))

    assert item.body == "Yes please"


async def test_a_quote_is_provenance_not_membership():
    """`context.id` says which message was quoted. It must not change which
    conversation the reply belongs to — that is `thread_key`'s job, and the
    person is still the thread."""
    quoting = _text("wamid.CCC", "about that", context={"id": "wamid.AAA", "from": PHONE_ID})

    (item,) = items_from_webhook(_source(), _webhook(quoting))

    assert item.reply_to_external_id == "wamid.AAA"
    assert item.thread_key == WA_ID


async def test_a_shape_we_do_not_render_yields_nothing_rather_than_raising():
    """Meta RETRIES a non-2xx and keeps retrying, so refusing to parse one
    entry would replay the whole batch forever. An image is a real message this
    driver does not render yet; it must cost a record, not the request."""
    image = {"id": "wamid.IMG", "from": WA_ID, "timestamp": "1789000002", "type": "image", "image": {"id": "media"}}

    assert items_from_webhook(_source(), _webhook(image)) == []
    assert items_from_webhook(_source(), {"entry": "not a list"}) == []
    assert items_from_webhook(_source(), {}) == []


async def test_a_number_is_read_in_one_spelling():
    """Meta sends `972501234567`; a person types `+972-50-123-4567`. Two
    spellings of one correspondent would fork the conversation."""
    assert whatsapp_module._digits("+972-50-123 4567") == WA_ID
    assert whatsapp_module._digits(None) == ""


# ── fetch: the deliberate no-op ──────────────────────────────────────────────


async def test_fetch_reports_unchanged_because_there_is_nothing_to_poll():
    """Not a stub. Meta publishes no endpoint that lists messages, so a poll is
    a request that cannot return one however often it runs."""
    result = await WhatsAppDriver().fetch(
        _source(), SegmentCursorView(segment_key="messages", state={}, window_start=None, first_run=True)
    )

    assert result.unchanged is True
    assert result.items == []


# ── send ─────────────────────────────────────────────────────────────────────


class _Graph:
    def __init__(self, replies):
        self.replies = replies
        self.requests: list[str] = []
        self.bodies: list[str] = []

    def __call__(self, path, headers):
        self.requests.append(path)
        self.bodies.append(str(headers.get("_body") or ""))
        status, reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return status, json.dumps(reply).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def serve(monkeypatch, request):
    def _factory(replies):
        graph = _Graph(replies)
        server = local_http_server(graph)
        base = server.__enter__()
        # The loopback server has no version prefix; fold it into the base so
        # the driver's own path building is what is under test.
        monkeypatch.setattr(whatsapp_module, "GRAPH_API_BASE", base)
        monkeypatch.setattr(whatsapp_module, "GRAPH_VERSION", "v23.0")
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return graph

    return _factory


async def test_a_reply_quotes_the_message_it_answers(serve, monkeypatch):
    recorded: list = []
    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", lambda items, **_: _async(recorded.extend(items)))
    graph = serve([(200, {"messages": [{"id": "wamid.OUT"}]})])

    outcome = await WhatsAppDriver().send(_source(), thread_key=WA_ID, to=WA_ID, text="hi", in_reply_to="wamid.AAA")

    assert outcome.external_id == "wamid.OUT"
    body = json.loads(graph.bodies[0])
    assert body["to"] == WA_ID
    assert body["type"] == "text"
    assert body["context"] == {"message_id": "wamid.AAA"}
    assert graph.requests[0].endswith(f"/{PHONE_ID}/messages")


async def test_the_sent_copy_is_recorded_because_nothing_will_echo_it(serve, monkeypatch):
    """Our own outbound comes back only as a delivery `status`, never as a
    message — so this is the one copy that will ever exist. Without it the
    inbox shows the human talking to themselves."""
    recorded: list = []
    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", lambda items, **_: _async(recorded.extend(items)))
    serve([(200, {"messages": [{"id": "wamid.OUT"}]})])

    outcome = await WhatsAppDriver().send(_source(), thread_key=WA_ID, to=WA_ID, text="answering")

    assert outcome.recorded is True
    assert [i.external_id for i in recorded] == ["wamid.OUT"]
    assert recorded[0].thread_key == WA_ID
    assert recorded[0].author_external_id == PHONE_ID


async def test_a_refused_send_does_not_park_the_source(serve):
    """The send contract: a refused message is the caller's problem, not the
    source's health. A reply outside the 24-hour window lands here."""
    serve([(400, {"error": {"message": "Message failed to send because more than 24 hours have passed"}})])

    with pytest.raises(ValueError, match="24 hours"):
        await WhatsAppDriver().send(_source(), thread_key=WA_ID, to=WA_ID, text="too late")


async def test_a_send_without_a_recipient_refuses():
    with pytest.raises(ValueError, match="wa_id"):
        await WhatsAppDriver().send(_source(), thread_key="", to="", text="hi")


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_names_the_number_it_will_send_as(serve):
    serve([(200, {"display_phone_number": "15550001111", "id": PHONE_ID})])

    verdict = await WhatsAppDriver().verify(_source())

    assert verdict.ready is True
    assert "15550001111" in verdict.detail


async def test_an_expired_token_says_which_token_to_make(serve):
    """The setup page hands out a 24-hour token, so this is the failure every
    first-time integrator hits — and "unauthorized" alone would send them
    looking at the phone number id."""
    serve([(401, {"error": {"message": "Session has expired"}})])

    verdict = await WhatsAppDriver().verify(_source())

    assert verdict.ready is False
    assert "System User" in verdict.detail


async def test_a_source_with_no_token_asks_for_one():
    source = _source()
    source.config = {"phone_number_id": PHONE_ID}

    verdict = await WhatsAppDriver().verify(source)

    assert verdict.ready is False
    assert "access token" in verdict.detail


def _async(_result=None):
    """A coroutine that has already done its work — the monkeypatched
    `ingest_items` returns one so `await` succeeds."""

    async def _done():
        return _Report()

    return _done()


class _Report:
    created = 1


# ── the webhook route ────────────────────────────────────────────────────────
#
# Called directly rather than through a TestClient: this repo has an incident on
# file where a TestClient closed the DB out from under the app, and the route is
# two plain functions over a request — there is nothing a server adds to the
# question being asked here.


class _Request:
    def __init__(self, *, query: dict | None = None, body: dict | None = None):
        self.query_params = query or {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


async def _saved(**config) -> DataSource:
    source = _source(**config)
    await source.save()
    return source


async def test_the_handshake_echoes_the_challenge_when_the_token_matches():
    """Meta compares the body byte for byte, so the response is the bare
    challenge — a JSON envelope here reads as a failed verification with no
    explanation."""
    from flow_sdk.server.routes.whatsapp import verify_webhook

    await _saved(verify_token="s3cret", phone_number_id="handshake-ok")

    response = await verify_webhook(
        _Request(query={"hub.mode": "subscribe", "hub.verify_token": "s3cret", "hub.challenge": "1234"})
    )

    assert response.status_code == 200
    assert response.body == b"1234"


async def test_the_handshake_refuses_a_token_no_source_carries():
    from flow_sdk.server.routes.whatsapp import verify_webhook

    await _saved(verify_token="s3cret", phone_number_id="handshake-bad")

    response = await verify_webhook(
        _Request(query={"hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1234"})
    )

    assert response.status_code == 403


async def test_a_batch_for_an_unknown_number_answers_200():
    """404 would be honest and wrong: Meta retries a failure, and no amount of
    retrying makes a source exist. The log is where a person finds out."""
    from flow_sdk.server.routes.whatsapp import receive_webhook

    response = await receive_webhook(_Request(body=_webhook(_text("wamid.ZZZ", "hi"), phone_number_id="nobody-here")))

    assert response.data["ingested"] == 0
    assert "no source" in response.data["reason"]


async def test_a_batch_reaches_the_ingestor_through_the_one_chokepoint(monkeypatch):
    """Not a second ingestion path: the digest gate, the local-state
    preservation and the `ingest.*` events all come from `ingest_items`."""
    from flow_sdk.server.routes import whatsapp as route

    # A number of this test's own: `_source_for` scans every whatsapp row, and
    # asserting on the FIRST match would pin whichever row a sibling test left.
    mine = "chokepoint-999"
    source = await _saved(verify_token="t", phone_number_id=mine)
    seen: list = []
    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", lambda items, **_: _async(seen.extend(items)))

    response = await route.receive_webhook(
        _Request(body=_webhook(_text("wamid.YYY", "hello there"), phone_number_id=mine))
    )

    assert response.data["ingested"] == 1
    assert [i.external_id for i in seen] == ["wamid.YYY"]
    assert seen[0].data_source_id == source.id
