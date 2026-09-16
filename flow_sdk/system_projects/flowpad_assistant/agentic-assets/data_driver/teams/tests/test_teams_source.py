"""The ``teams`` data source, against a real socket serving Microsoft Graph's own shapes.

Graph breaks a different set of assumptions than Slack did: a channel is addressed only through
its team, so a segment is composite; ``/messages`` returns ROOTS and the conversation lives in
``replies``; there is no ``$filter``, so "since" is decided here over whole reply chains; and
message bodies are HTML even when someone typed one bare sentence.
"""
from __future__ import annotations

import json
import uuid
from urllib.parse import parse_qs, unquote

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.driver_types import driver_type
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

TeamsSource = asset_module("teams").TeamsSource
split_segment = asset_module("teams").split_segment
teams_source = asset_module("teams")

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

TEAM = "fbe2bf47-16c8-47cf-b4a5-4b9b187c508b"
CHANNEL = "19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2"
SEGMENT = f"{TEAM}/{CHANNEL}"


def _source(**config) -> DataSource:
    return DataSource(provider="teams", name=f"Teams test {uuid.uuid4().hex[:8]}", config={"channels": [SEGMENT], **config})


def _view(state: dict | None = None, window_start: str | None = None):
    return position(segment_key=SEGMENT, prior=state or {}, window_start=window_start)


def _message(message_id: str, text: str, *, created: str, **extra) -> dict:
    """A `chatMessage` in the shape Graph actually sends — HTML body included."""
    return {
        "id": message_id, "replyToId": None, "messageType": "message", "createdDateTime": created,
        "from": {"user": {"id": "U1", "displayName": "Robin Kline", "userIdentityType": "aadUser"}},
        "body": {"contentType": "html", "content": f"<div>{text}</div>"},
        "webUrl": f"https://teams.microsoft.com/l/message/{CHANNEL}/{message_id}", **extra,
    }


def _token(value):
    async def resolve(_row):
        return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr(value)) if value else Credentials()

    return resolve


@pytest.fixture(autouse=True)
def _a_token(monkeypatch):
    monkeypatch.setattr(driver_type("teams"), "credentials_for", _token("graph-test-token"))


class _Graph:
    """A Graph that records what it was asked and answers what it is told to."""

    def __init__(self, replies):
        self.replies, self.requests, self.bodies = replies, [], []

    def __call__(self, path, headers):
        self.requests.append(unquote(path))
        self.bodies.append(str(headers.get("_body") or ""))
        status, reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return status, json.dumps(reply).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def serve(monkeypatch, request):
    def _factory(replies) -> _Graph:
        graph = _Graph(replies)
        server = local_http_server(graph)
        monkeypatch.setattr(teams_source, "GRAPH_API_BASE", server.__enter__())
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return graph

    return _factory


# ── the contract, over a stateful Graph ──────────────────────────────────────


class _FakeGraph:
    def __init__(self):
        self.roots = [_message(str(n), f"root {n}", created=f"2026-09-01T1{n}:00:00Z") for n in (1, 2, 3)]
        self.replies: dict[str, list[dict]] = {}
        self.next_id = 100

    def __call__(self, path, headers):
        route, _, query = unquote(path).partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        parts = route.strip("/").split("/")
        if parts == ["me"]:
            return self._ok({"id": "ME", "userPrincipalName": "me@x.test"})
        if parts == ["chats"]:
            return self._ok({"id": "chat-1"})
        if parts[0] == "chats":
            return self._created(None)
        if parts[:4] != ["teams", TEAM, "channels", CHANNEL]:
            return 404, json.dumps({"error": {"message": "NotFound"}}).encode(), {}
        rest = parts[5:]
        if body:
            root = rest[0] if rest else None
            if root is not None and root not in {r["id"] for r in self.roots}:
                return 404, json.dumps({"error": {"message": "NotFound"}}).encode(), {}
            return self._created(root)
        if rest:
            found = next((m for m in self.roots + sum(self.replies.values(), []) if m["id"] == rest[0]), None)
            return self._ok(found) if found else (404, json.dumps({"error": {"message": "NotFound"}}).encode(), {})
        skip, top = int(params.get("$skip") or 0), int(params.get("$top") or 20)
        page = [{**r, "replies": self.replies.get(r["id"], [])} for r in self.roots[skip:skip + top]]
        more = skip + top < len(self.roots)
        link = f"{teams_source.GRAPH_API_BASE}/teams/{TEAM}/channels/{CHANNEL}/messages?$top={top}&$skip={skip + top}"
        return self._ok({"value": page, **({"@odata.nextLink": link} if more else {})})

    def _created(self, root):
        self.next_id += 1
        message = _message(str(self.next_id), "sent", created="2026-09-02T10:00:00Z", replyToId=root)
        if root is not None:
            self.replies.setdefault(root, []).append(message)
        return self._ok(message)

    @staticmethod
    def _ok(payload):
        return 200, json.dumps(payload).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def fake_graph(monkeypatch):
    graph = _FakeGraph()
    with local_http_server(graph) as base:
        monkeypatch.setattr(teams_source, "GRAPH_API_BASE", base)
        yield graph


@pytest.mark.parametrize("check", checks_for(TeamsSource), ids=str)
async def test_conformance(check, fake_graph):
    binding = SourceBinding(config={"channels": [SEGMENT]}, credentials=Credentials(shape=AuthShape.CONNECTOR, token=SecretStr("t")))
    probe = TeamsSource(binding)
    await check.run(Subject(
        source=lambda: TeamsSource(binding),
        seeded=tuple(probe.origin(n, SEGMENT) for n in ("1", "2", "3")),
        conversation=probe.origin("1", SEGMENT),
        recipient=UserProfile(origin=probe.origin("U2"), name="Ada"),
    ))


# ── segments ─────────────────────────────────────────────────────────────────


async def test_a_segment_is_keyed_by_team_and_channel_together():
    (segment,) = await driver_type("teams").segments(_source())
    assert segment.key == SEGMENT and split_segment(segment.key) == (TEAM, CHANNEL)


def test_a_key_without_a_team_names_nothing():
    assert split_segment(CHANNEL) == ("", "")


# ── fetch ────────────────────────────────────────────────────────────────────


async def test_a_root_and_its_replies_are_one_conversation(serve):
    root = _message("100", "the question", created="2026-09-01T10:00:00Z")
    root["replies"] = [dict(_message("101", "an answer", created="2026-09-01T10:05:00Z"), replyToId="100")]
    serve([(200, {"value": [root]})])
    result = await driver_type("teams").traverse(_source(), _view())
    assert [i.external_id for i in result.items] == ["100", "101"]
    assert {i.thread_key for i in result.items} == {"100"} and result.items[1].reply_to_external_id == "100"


async def test_a_page_ingests_oldest_first(serve):
    serve([(200, {"value": [_message("200", "later", created="2026-09-01T12:00:00Z"), _message("100", "earlier", created="2026-09-01T10:00:00Z")]})])
    assert [i.body for i in (await driver_type("teams").traverse(_source(), _view())).items] == ["earlier", "later"]


async def test_messages_already_seen_are_not_ingested_again(serve):
    root = _message("100", "the question", created="2026-09-01T10:00:00Z")
    root["replies"] = [
        dict(_message("101", "old answer", created="2026-09-01T10:05:00Z"), replyToId="100"),
        dict(_message("102", "new answer", created="2026-09-01T11:00:00Z"), replyToId="100"),
    ]
    serve([(200, {"value": [root]})])
    result = await driver_type("teams").traverse(_source(), _view(state={"cursor": TeamsSource.resume_after("2026-09-01T10:30:00Z")}))
    assert [i.external_id for i in result.items] == ["102"]
    assert result.cursor == TeamsSource.resume_after("2026-09-01T11:00:00Z")


async def test_a_legacy_high_water_is_adopted(serve):
    serve([(200, {"value": [_message("100", "old", created="2026-09-01T10:00:00Z")]})])
    result = await driver_type("teams").traverse(_source(), _view(state={"last_created": "2026-09-01T10:00:00Z"}))
    assert result.unchanged is True and result.items == []


async def test_system_events_are_not_messages_but_move_the_cursor(serve):
    event = _message("100", "", created="2026-09-01T10:00:00Z", messageType="systemEventMessage")
    event["from"] = None
    serve([(200, {"value": [event]})])
    result = await driver_type("teams").traverse(_source(), _view())
    assert result.items == [] and result.cursor == TeamsSource.resume_after("2026-09-01T10:00:00Z")


async def test_the_body_is_stored_as_text(serve):
    message = _message("100", "", created="2026-09-01T10:00:00Z")
    message["body"] = {"contentType": "html", "content": "<div>first line<br/>second &amp; last</div>"}
    serve([(200, {"value": [message]})])
    (item,) = (await driver_type("teams").traverse(_source(), _view())).items
    assert item.body == "first line\nsecond & last"


async def test_the_permalink_is_graphs_own(serve):
    serve([(200, {"value": [_message("100", "hi", created="2026-09-01T10:00:00Z")]})])
    (item,) = (await driver_type("teams").traverse(_source(), _view())).items
    assert item.permalink.endswith("/100")


# ── send ─────────────────────────────────────────────────────────────────────


async def test_a_reply_goes_under_the_thread_root(serve):
    graph = serve([(200, {"id": "999"}), (200, {"id": "ME", "userPrincipalName": "a@b.com"})])
    outcome = await driver_type("teams").send(_source(), thread_key="100", to=SEGMENT, text="answering")
    assert outcome.external_id == "999"
    assert graph.requests[0].endswith(f"/teams/{TEAM}/channels/{CHANNEL}/messages/100/replies")
    assert json.loads(graph.bodies[0]) == {"body": {"contentType": "text", "content": "answering"}}, "no agent persona: Graph posts as the user"


async def test_a_send_with_no_thread_is_a_new_root(serve):
    graph = serve([(200, {"id": "999"}), (200, {"id": "ME"})])
    await driver_type("teams").send(_source(), thread_key="", to=SEGMENT, text="opening", subject="Status")
    assert graph.requests[0].endswith(f"/channels/{CHANNEL}/messages") and json.loads(graph.bodies[0])["subject"] == "Status"


async def test_a_send_without_a_team_refuses():
    with pytest.raises(ValueError, match="teamId"):
        await driver_type("teams").send(_source(), thread_key="100", to=CHANNEL, text="hi")


async def test_a_refused_post_does_not_park_the_source(serve):
    serve([(403, {"error": {"code": "Forbidden", "message": "Missing ChannelMessage.Send"}})])
    with pytest.raises(ValueError, match="refused"):
        await driver_type("teams").send(_source(), thread_key="100", to=SEGMENT, text="hi")


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_reads_every_channel_before_saying_yes(serve):
    graph = serve([(200, {"value": []}), (200, {"id": "me", "userPrincipalName": "a@b.com"})])
    verdict = await driver_type("teams").verify(_source())
    assert verdict.ready is True and "1 channel" in verdict.detail and "top=1" in graph.requests[0]


async def test_a_missing_permission_says_which_one(serve):
    serve([(403, {"error": {"message": "Access denied"}})])
    verdict = await driver_type("teams").verify(_source())
    assert verdict.ready is False and "ChannelMessage.Read.All" in verdict.detail


async def test_a_channel_we_cannot_see_is_pending_not_broken(serve):
    serve([(404, {"error": {"message": "NotFound"}}), (200, {"id": "me"})])
    verdict = await driver_type("teams").verify(_source())
    assert verdict.ready is False and verdict.pending == (SEGMENT,)


async def test_a_source_with_no_channels_asks_for_one():
    source = _source()
    source.config = {"channels": []}
    verdict = await driver_type("teams").verify(source)
    assert verdict.ready is False and "No channels" in verdict.detail


# ── choices and the outbound spec ────────────────────────────────────────────


async def test_the_picker_offers_the_composite_id(serve):
    serve([(200, {"value": [{"id": TEAM, "displayName": "Engineering"}]}), (200, {"value": [{"id": CHANNEL, "displayName": "General"}]})])
    (offer,) = await driver_type("teams").choices(_source(), "channels")
    assert (offer.id, offer.name) == (SEGMENT, "Engineering / General")


async def test_a_reply_is_addressed_to_the_channel_not_the_author():
    from flow_sdk.builtin.source_item import TeamsMessageSpec

    driver = driver_type("teams")
    assert driver.outbound_spec(_source()) is TeamsMessageSpec
    item = type("Item", (), {"segment_key": SEGMENT, "thread_key": "100", "external_id": "101"})()
    spec = driver.outbound_spec(_source()).reply_to(item, body="answering")
    assert (spec.to, spec.thread_key) == ([SEGMENT], "100")
