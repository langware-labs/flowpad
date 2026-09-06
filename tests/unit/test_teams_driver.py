"""The Teams driver, against a real socket serving Microsoft Graph's own shapes.

Graph breaks a different set of assumptions than Slack did, and every test here
pins one of the breaks:

* a channel is addressed only through its team, so a stream key is composite;
* ``/messages`` returns ROOTS, and the conversation lives in ``replies``;
* there is no ``$filter`` on this collection, so "since last time" is decided
  here, after the fetch, over whole reply chains that come back in full;
* message bodies are HTML even when someone typed one bare sentence.

A stubbed httpx client would let all four pass while broken, so this uses the
same loopback server the other driver tests do.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers import teams as teams_module
from flow_sdk.ingest.drivers.teams import TeamsDriver
from tests.unit._ingest_helpers import local_http_server, with_token

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TEAM = "fbe2bf47-16c8-47cf-b4a5-4b9b187c508b"
CHANNEL = "19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2"
SEGMENT = f"{TEAM}/{CHANNEL}"


def _source(**config) -> DataSource:
    return DataSource(provider="teams", name="Teams test", config={"channels": [SEGMENT], **config})


def _view(state: dict | None = None, window_start: str | None = None) -> SegmentCursorView:
    return SegmentCursorView(
        segment_key=SEGMENT,
        state=state or {},
        window_start=window_start,
        first_run=not state,
    )


def _message(message_id: str, text: str, *, created: str, **extra) -> dict:
    """A `chatMessage` in the shape Graph actually sends — HTML body included."""
    return {
        "id": message_id,
        "replyToId": None,
        "messageType": "message",
        "createdDateTime": created,
        "from": {"user": {"id": "U1", "displayName": "Robin Kline", "userIdentityType": "aadUser"}},
        "body": {"contentType": "html", "content": f"<div>{text}</div>"},
        "channelIdentity": {"teamId": TEAM, "channelId": CHANNEL},
        "webUrl": f"https://teams.microsoft.com/l/message/{CHANNEL}/{message_id}",
        **extra,
    }


class _Graph:
    """A Graph that records what it was asked and answers what it is told to."""

    def __init__(self, replies: list[tuple[int, dict]]):
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
    """Point the driver at a local Graph that replies with `replies` in order."""

    def _factory(replies: list[tuple[int, dict]]) -> _Graph:
        graph = _Graph(replies)
        server = local_http_server(graph)
        monkeypatch.setattr(teams_module, "GRAPH_API_BASE", server.__enter__())
        with_token(monkeypatch, TeamsDriver, "graph-test-token")
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return graph

    return _factory


# ── streams ──────────────────────────────────────────────────────────────────


async def test_a_stream_is_keyed_by_team_and_channel_together():
    """A channel id is not unique across teams, and Graph addresses a channel
    only through one. Keyed on the channel alone, two teams' channels would
    collide and neither would be fetchable."""
    (stream,) = await TeamsDriver().segments(_source())

    assert stream.key == SEGMENT
    assert teams_module._split(stream.key) == (TEAM, CHANNEL)


async def test_a_key_without_a_team_names_nothing():
    """Half an address is not an address: better to resolve to empties that the
    caller refuses than to build a URL with a hole in it."""
    assert teams_module._split(CHANNEL) == ("", "")


# ── fetch ────────────────────────────────────────────────────────────────────


async def test_a_root_and_its_replies_are_one_conversation(serve):
    """`thread_key` is the ROOT's id for both. Teams has exactly two levels, so
    a reply to a reply is still a reply to the root — which is why nothing here
    walks a chain."""
    root = _message("100", "the question", created="2026-09-01T10:00:00Z")
    root["replies"] = [
        dict(_message("101", "an answer", created="2026-09-01T10:05:00Z"), replyToId="100"),
    ]
    serve([(200, {"value": [root]})])

    result = await TeamsDriver().fetch(_source(), _view())

    assert [i.external_id for i in result.items] == ["100", "101"]
    assert {i.thread_key for i in result.items} == {"100"}
    assert result.items[1].reply_to_external_id == "100"


async def test_a_page_ingests_oldest_first(serve):
    """Graph orders by which conversation changed last, not by when anything was
    said. A conversation read backwards is worse than one read late."""
    serve(
        [
            (
                200,
                {
                    "value": [
                        _message("200", "later", created="2026-09-01T12:00:00Z"),
                        _message("100", "earlier", created="2026-09-01T10:00:00Z"),
                    ]
                },
            )
        ]
    )

    result = await TeamsDriver().fetch(_source(), _view())

    assert [i.body for i in result.items] == ["earlier", "later"]


async def test_messages_already_seen_are_not_ingested_again(serve):
    """The whole reply chain comes back whenever any of it changes, and Graph
    accepts no filter — so the floor is applied here or every old reply
    re-ingests on the next new one."""
    root = _message("100", "the question", created="2026-09-01T10:00:00Z")
    root["replies"] = [
        dict(_message("101", "old answer", created="2026-09-01T10:05:00Z"), replyToId="100"),
        dict(_message("102", "new answer", created="2026-09-01T11:00:00Z"), replyToId="100"),
    ]
    serve([(200, {"value": [root]})])

    result = await TeamsDriver().fetch(_source(), _view(state={"last_created": "2026-09-01T10:30:00Z"}))

    assert [i.external_id for i in result.items] == ["102"]
    assert result.next_state["last_created"] == "2026-09-01T11:00:00Z"


async def test_a_channel_with_nothing_new_reports_unchanged(serve):
    serve([(200, {"value": [_message("100", "old", created="2026-09-01T10:00:00Z")]})])

    result = await TeamsDriver().fetch(_source(), _view(state={"last_created": "2026-09-01T10:00:00Z"}))

    assert result.unchanged is True
    assert result.items == []


async def test_system_events_are_not_messages(serve):
    """A join or a channel rename is a real event, but nobody wrote it — and it
    would land in the inbox as a conversation entry from no one. It still moves
    the cursor: skipping it must not mean re-reading it forever."""
    event = _message("100", "", created="2026-09-01T10:00:00Z", messageType="systemEventMessage")
    event["from"] = None
    serve([(200, {"value": [event]})])

    result = await TeamsDriver().fetch(_source(), _view())

    assert result.items == []
    assert result.next_state["last_created"] == "2026-09-01T10:00:00Z"


async def test_the_body_is_stored_as_text(serve):
    """Graph sends HTML for anything typed in the client, including one bare
    sentence. The inbox stores text and the agent reads what the inbox stored."""
    body = "<div>first line<br/>second &amp; last</div>"
    message = _message("100", "", created="2026-09-01T10:00:00Z")
    message["body"] = {"contentType": "html", "content": body}
    serve([(200, {"value": [message]})])

    (item,) = (await TeamsDriver().fetch(_source(), _view())).items

    assert item.body == "first line\nsecond & last"


async def test_the_permalink_is_graphs_own(serve):
    """Unlike Slack's, this link does not have to be constructed — and a
    constructed one would be a second spelling to keep right."""
    serve([(200, {"value": [_message("100", "hi", created="2026-09-01T10:00:00Z")]})])

    (item,) = (await TeamsDriver().fetch(_source(), _view())).items

    assert item.permalink.endswith("/100")


# ── send ─────────────────────────────────────────────────────────────────────


async def test_a_reply_goes_under_the_thread_root(serve):
    graph = serve([(200, {"id": "999"})])

    outcome = await TeamsDriver().send(_source(), thread_key="100", to=SEGMENT, text="answering")

    assert outcome.external_id == "999"
    assert graph.requests[0].endswith(f"/teams/{TEAM}/channels/{CHANNEL}/messages/100/replies")
    assert json.loads(graph.bodies[0])["body"] == {"contentType": "text", "content": "answering"}


async def test_a_send_with_no_thread_is_a_new_root(serve):
    graph = serve([(200, {"id": "999"})])

    await TeamsDriver().send(_source(), thread_key="", to=SEGMENT, text="opening", subject="Status")

    assert graph.requests[0].endswith(f"/channels/{CHANNEL}/messages")
    assert json.loads(graph.bodies[0])["subject"] == "Status"


async def test_a_send_carries_no_agent_persona(serve):
    """Graph posts as the signed-in user; there is no per-message name or
    avatar. Stamping one would be sending a field Graph rejects — and promising
    the user something Teams does not do."""
    graph = serve([(200, {"id": "999"})])

    await TeamsDriver().send(_source(), thread_key="100", to=SEGMENT, text="answering")

    assert set(json.loads(graph.bodies[0])) == {"body"}


async def test_a_send_without_a_team_refuses():
    """A Teams `thread_key` is a bare message id and names no channel, so `to`
    is the only thing that can carry the address."""
    with pytest.raises(ValueError, match="teamId"):
        await TeamsDriver().send(_source(), thread_key="100", to=CHANNEL, text="hi")


async def test_a_refused_post_does_not_park_the_source(serve):
    """The send contract: a refused post is the caller's problem, not the
    source's health — one bad reply must not stop the channel ingesting."""
    serve([(403, {"error": {"code": "Forbidden", "message": "Missing ChannelMessage.Send"}})])

    with pytest.raises(ValueError, match="refused"):
        await TeamsDriver().send(_source(), thread_key="100", to=SEGMENT, text="hi")


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_reads_every_channel_before_saying_yes(serve):
    graph = serve([(200, {"value": []}), (200, {"id": "me", "userPrincipalName": "a@b.com"})])

    verdict = await TeamsDriver().verify(_source())

    assert verdict.ready is True
    assert "1 channel" in verdict.detail
    # `$` arrives percent-encoded, which Graph accepts. The point is the probe
    # asked for ONE message: the cheapest question with the right answer.
    assert "top=1" in graph.requests[0]


async def test_a_missing_permission_says_which_one(serve):
    """403 is an app-configuration problem — a permission never granted, or a
    tenant admin who has not consented. No amount of retrying fixes it, and
    sending the user to check the channel ids would waste their time."""
    serve([(403, {"error": {"message": "Access denied"}})])

    verdict = await TeamsDriver().verify(_source())

    assert verdict.ready is False
    assert "ChannelMessage.Read.All" in verdict.detail


async def test_a_channel_we_cannot_see_is_pending_not_broken(serve):
    """404 means this account is not in the team, or the ids are wrong. Both are
    a person's next action, which is what `pending` is for — the source is
    unfinished, not failed."""
    serve([(404, {"error": {"message": "NotFound"}})])

    verdict = await TeamsDriver().verify(_source())

    assert verdict.ready is False
    assert verdict.pending == (SEGMENT,)


async def test_a_source_with_no_channels_asks_for_one():
    source = _source()
    source.config = {"channels": []}

    verdict = await TeamsDriver().verify(source)

    assert verdict.ready is False
    assert "No channels" in verdict.detail


# ── choices ──────────────────────────────────────────────────────────────────


async def test_the_picker_offers_the_composite_id(serve):
    """What the form stores has to be what a fetch can address, so the offer is
    the same `{team}/{channel}` key the driver splits later."""
    serve(
        [
            (200, {"value": [{"id": TEAM, "displayName": "Engineering"}]}),
            (200, {"value": [{"id": CHANNEL, "displayName": "General"}]}),
        ]
    )

    (offer,) = await TeamsDriver().choices(_source(), "channels")

    assert offer.id == SEGMENT
    assert offer.name == "Engineering / General"


# ── the outbound spec ────────────────────────────────────────────────────────


async def test_a_reply_is_addressed_to_the_channel_not_the_author():
    """The rule `MessageSpec` states: channels disagree about who a reply
    targets. Naming `EmailMessageSpec` here would address the author, which in
    Teams is a person — a DM instead of a post everyone can read."""
    from flow_sdk.builtin.source_item import TeamsMessageSpec

    driver = TeamsDriver()
    assert driver.outbound_spec(_source()) is TeamsMessageSpec

    inbound = (await driver.segments(_source()))[0]
    item = type("Item", (), {"segment_key": inbound.key, "thread_key": "100", "external_id": "101"})()
    spec = driver.outbound_spec(_source()).reply_to(item, body="answering")

    assert spec.to == [SEGMENT]
    assert spec.thread_key == "100"
