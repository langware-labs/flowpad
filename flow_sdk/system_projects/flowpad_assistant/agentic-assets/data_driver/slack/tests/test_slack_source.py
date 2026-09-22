"""The ``slack`` data source, against a real socket serving Slack's own response shapes.

Slack breaks the assumptions the first sources were written under, and these pin each break:
it answers **200 with ``ok: false``**; it will not let an app read a channel nobody invited it
to, which is a SETUP state; and it allows **one history request a minute**, so a pass reads one
page of the channel. A stubbed client would let all three pass while broken.
"""
from __future__ import annotations

import json
import sys
import time
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

SlackSource = asset_module("slack").SlackSource
slack_source = asset_module("slack")

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

CHANNEL = "C0123456789"
#: Where the test's Slack listens — set by the fixture that starts one, read into every row's ``base_url``.
BASE = ""


def _saved_channel() -> str:
    """A channel no other saved row watches: a channel is the row's identity, so two saved rows
    naming the same one are refused."""
    return "C0" + uuid.uuid4().hex[:9].upper()


def _source(**config) -> DataSource:
    return DataSource(provider="slack", name=f"Slack test {uuid.uuid4().hex[:8]}", config={"channel": CHANNEL, "base_url": BASE, **config})


def _view(cursor: str | None = None, window_start: str | None = None):
    return position(cursor=cursor, window_start=window_start)


def _message(ts: str, text: str, **extra) -> dict:
    return {"type": "message", "user": "U1", "ts": ts, "text": text, **extra}


def _credentials(token):
    async def resolve(_row):
        return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else Credentials()

    return resolve


@pytest.fixture(autouse=True)
def _a_token(monkeypatch):
    monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", _credentials("xoxp-test"))


class _Slack:
    """A Slack that records what it was asked and answers what it is told to."""

    def __init__(self, replies: list[dict]):
        self.replies, self.requests, self.bodies = replies, [], []

    def __call__(self, path, headers):
        self.requests.append(path)
        self.bodies.append(str(headers.get("_body") or ""))
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return 200, json.dumps(reply).encode(), {"Content-Type": "application/json"}  # 200 even for errors


@pytest.fixture
def serve(monkeypatch, request):
    def _factory(replies: list[dict]) -> _Slack:
        slack = _Slack(replies)
        server = local_http_server(slack)
        monkeypatch.setattr(sys.modules[__name__], "BASE", server.__enter__())
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return slack

    return _factory


# ── the contract, over a stateful double ─────────────────────────────────────


class _FakeSlack:
    """Channel histories, posts appended with fresh ts, DMs opened on demand. ``posts`` is every
    ``chat.postMessage`` it accepted, in order; ``arrive`` is a message someone else wrote."""

    def __init__(self):
        self.clock = 300.0
        self.channels = {"C1": [_message("100.000100", "root"), _message("150.000150", "in thread", thread_ts="100.000100"), _message("200.000200", "later")]}
        self.posts: list[dict] = []

    def fresh_ts(self) -> str:
        """A ts later than every one handed out so far and never behind the wall clock, so a
        message written now lands after a resume cursor taken a moment ago."""
        self.clock = max(time.time(), self.clock + 0.000001)
        return f"{self.clock:.6f}"

    def arrive(self, channel: str, text: str, *, user: str, thread_ts: str | None = None) -> dict:
        extra = {"thread_ts": thread_ts} if thread_ts else {}
        message = {**_message(self.fresh_ts(), text, **extra), "user": user}
        self.channels.setdefault(channel, []).append(message)
        return message

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        method = route.lstrip("/")
        if method == "auth.test":
            return self._ok(user_id="UBOT", bot_id="B1", user="flowpad", team_id="T1")
        if method == "conversations.open":
            self.channels.setdefault("D1", [])
            return self._ok(channel={"id": "D1"})
        channel = params.get("channel") or body.get("channel")
        if channel not in self.channels:
            return self._ok(ok=False, error="channel_not_found")
        if method == "chat.postMessage":
            ts = self.fresh_ts()
            thread = body.get("thread_ts") or None
            self.channels[channel].append(_message(ts, body["text"], **({"thread_ts": thread} if thread else {})))
            self.posts.append({"to": channel, "text": body["text"], "thread": thread, "external_id": ts})
            return self._ok(ts=ts, channel=channel)
        rows = sorted(self.channels[channel], key=lambda m: float(m["ts"]), reverse=True)
        if "latest" in params:
            rows = [m for m in rows if float(m["ts"]) <= float(params["latest"])]
        if "oldest" in params:
            rows = [m for m in rows if float(m["ts"]) > float(params["oldest"])]
        start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 100)
        more = start + limit < len(rows)
        return self._ok(messages=rows[start:start + limit], response_metadata={"next_cursor": str(start + limit) if more else ""})

    @staticmethod
    def _ok(ok=True, **fields):
        return 200, json.dumps({"ok": ok, **fields}).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def fake_slack():
    with local_http_server(_FakeSlack()) as base:
        yield base


@pytest.mark.parametrize("check", checks_for(SlackSource), ids=str)
async def test_conformance(check, fake_slack):
    binding = SourceBinding(
        account_key="T1",
        config={"channel": "C1", "base_url": fake_slack},
        credentials=Credentials(shape=AuthShape.CONNECTOR, token=SecretStr("xoxb-test")),
    )
    probe = SlackSource(binding)
    await check.run(Subject(
        source=lambda: SlackSource(binding),
        seeded=tuple(probe.origin(ts, "C1") for ts in ("100.000100", "150.000150", "200.000200")),
        conversation=probe.origin("100.000100", "C1"),
        recipient=UserProfile(origin=probe.origin("U1"), name="Ada"),
    ))


# ── the double, as the matrix and a doubles process use it ───────────────────


async def test_the_double_delivers_after_the_source_exists_and_records_the_reply(monkeypatch):
    from pathlib import Path

    from flow_sdk.ingest.driver_registry import load_module

    Double = load_module(Path(__file__).parent, "matrix").Double
    with Double(channel=_saved_channel()) as double:
        monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", double.credentials)
        source = _source(**double.config)
        await source.save()
        driver = DataDriver.loaded("slack")

        first = await driver.traverse(source, _view())
        assert first.items == [] and first.unchanged, "the double delivered before anyone asked it to"
        assert first.cursor is None

        delivered = double.deliver("anyone home?", sender="U42")
        second = await driver.traverse(source, _view(first.cursor))
        (item,) = second.items
        assert (item.external_id, item.body, item.author_external_id) == (delivered["external_id"], "anyone home?", "U42")
        assert delivered["thread"] == delivered["external_id"], "a top-level message is its own thread"

        outcome = await driver.send(source, thread_key=item.thread_key, to=double.config["channel"], text="yes, here")
        assert double.sent() == [{"to": double.config["channel"], "text": "yes, here", "thread": item.thread_key, "external_id": outcome.external_id}]

        third = await driver.traverse(source, _view(second.cursor))
        assert [i.body for i in third.items] == ["yes, here"], "the post did not land in the channel history"


# ── the one channel ──────────────────────────────────────────────────────────


def test_the_query_keys_on_the_channel_id_not_its_name():
    source = SlackSource(SourceBinding(account_key="T1", config={"channel": {"id": CHANNEL, "name": "engineering"}}))
    assert source.channel == (CHANNEL, "engineering")
    assert source.query().conversation == source.channel_origin(CHANNEL)


def test_a_stored_list_of_channels_splits_into_one_source_per_channel():
    picked = {"id": CHANNEL, "name": "engineering"}
    parts = SlackSource.Config.split({"channels": [picked, "C0999999999"], "allowed_senders": ["U1"]})
    assert parts == [
        ("engineering", {"channel": picked, "allowed_senders": ["U1"]}),
        ("C0999999999", {"channel": "C0999999999", "allowed_senders": ["U1"]}),
    ]
    assert SlackSource.Config.split({"channel": CHANNEL}) is None


# ── fetch ────────────────────────────────────────────────────────────────────


async def test_a_page_becomes_items_oldest_first(serve):
    serve([{"ok": True, "messages": [_message("200.000200", "second"), _message("100.000100", "first")]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view())
    assert [i.body for i in result.items] == ["first", "second"]
    assert [i.external_id for i in result.items] == ["100.000100", "200.000200"]
    assert result.items[0].occurred_at == datetime.fromtimestamp(100.0001, tz=timezone.utc).isoformat()


async def test_the_cursor_resumes_from_the_last_ts(serve):
    slack = serve([{"ok": True, "messages": [_message("300.0", "next")]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("200.000200")))
    assert "oldest=200.000200" in slack.requests[0] and "inclusive=false" in slack.requests[0]
    assert result.cursor == SlackSource.resume_after("300.0")


async def test_ts_advances_numerically_not_lexically(serve):
    serve([{"ok": True, "messages": [_message("100.000000", "newer"), _message("90.000000", "older")]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("89.0")))
    assert result.cursor == SlackSource.resume_after("100.000000")


async def test_the_first_run_is_bounded_by_the_window(serve):
    slack = serve([{"ok": True, "messages": []}])
    await DataDriver.loaded("slack").traverse(_source(), _view(window_start="2026-08-01T00:00:00+00:00"))
    assert "oldest=1785542400.000000" in slack.requests[0]


async def test_a_pass_reads_one_page_and_never_paginates(serve):
    slack = serve([{
        "ok": True,
        "messages": [_message(f"{n}.0", str(n)) for n in range(1, 16)],
        "has_more": True,
        "response_metadata": {"next_cursor": "dXNlcjpVMDYxTkZUVDI="},
    }])
    result = await DataDriver.loaded("slack").traverse(_source(), _view())
    assert len(slack.requests) == 1, "paginated into the next minute's budget"
    assert "limit=15" in slack.requests[0] and len(result.items) == 15


async def test_an_empty_page_reports_unchanged(serve):
    serve([{"ok": True, "messages": []}])
    cursor = SlackSource.resume_after("1.0")
    result = await DataDriver.loaded("slack").traverse(_source(), _view(cursor))
    assert result.unchanged and result.items == [] and result.cursor == cursor, "an idle poll moved the cursor"


async def test_joins_and_leaves_are_not_messages_but_the_cursor_passes_them(serve):
    serve([{"ok": True, "messages": [
        _message("100.0", "hello"),
        _message("110.0", "x joined", subtype="channel_join"),
        _message("120.0", "renamed", subtype="channel_name"),
    ]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view())
    assert [i.body for i in result.items] == ["hello"]
    assert result.cursor == SlackSource.resume_after("120.0")


async def test_a_threaded_reply_joins_its_parents_conversation_without_a_guessed_reply_target(serve):
    serve([{"ok": True, "messages": [_message("150.0", "reply", thread_ts="100.0"), _message("100.0", "parent")]}])
    parent, reply = (await DataDriver.loaded("slack").traverse(_source(), _view())).items
    assert parent.thread_key == reply.thread_key == "100.0"
    assert parent.reply_to_external_id is None and reply.reply_to_external_id is None


async def test_the_permalink_is_a_formula_not_a_fetch(serve):
    slack = serve([{"ok": True, "messages": [_message("100.0", "hi")]}])
    (item,) = (await DataDriver.loaded("slack").traverse(_source(), _view())).items
    assert item.permalink == f"https://slack.com/app_redirect?channel={CHANNEL}&message_ts=100.0"
    assert len(slack.requests) == 1


# ── Slack's failure convention ───────────────────────────────────────────────


@pytest.mark.parametrize(("error", "health"), [
    ("invalid_auth", SourceHealth.CONFIG_ERROR),
    ("ratelimited", SourceHealth.TRANSIENT_ERROR),
    ("not_in_channel", SourceHealth.CONFIG_ERROR),
])
async def test_a_200_with_ok_false_is_a_failure_classified_by_what_fixes_it(serve, error, health):
    serve([{"ok": False, "error": error}])
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("slack").traverse(_source(), _view())
    assert classify(caught.value)[0] is health
    if error == "not_in_channel":
        assert "invite" in str(caught.value).lower()


async def test_no_credential_is_reported_before_any_request(serve, monkeypatch):
    slack = serve([{"ok": True, "messages": []}])
    monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", _credentials(None))
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("slack").traverse(_source(), _view())
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "Connect Slack" in str(caught.value)
    assert slack.requests == []


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_passes_when_the_channel_reads(serve):
    serve([{"ok": True, "messages": []}])
    assert (await DataDriver.loaded("slack").verify(_source())).ready is True


async def test_verify_names_a_channel_still_waiting_on_an_invite(serve):
    serve([{"ok": False, "error": "not_in_channel"}])
    verdict = await DataDriver.loaded("slack").verify(_source())
    assert verdict.ready is False and verdict.pending == (CHANNEL,) and CHANNEL in verdict.detail


async def test_verify_separates_a_missing_scope_from_a_missing_invite(serve):
    serve([{"ok": False, "error": "missing_scope"}])
    verdict = await DataDriver.loaded("slack").verify(_source())
    assert verdict.ready is False and verdict.pending == () and "channels:history" in verdict.detail


async def test_verify_refuses_a_source_with_no_channel():
    source = _source()
    source.config = {}
    verdict = await DataDriver.loaded("slack").verify(source)
    assert verdict.ready is False and "channel" in verdict.detail.lower()


# ── send ─────────────────────────────────────────────────────────────────────


async def test_send_posts_into_the_thread_and_returns_the_ts(serve):
    slack = serve([{"ok": True, "ts": "300.000300", "channel": CHANNEL}, {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"}])
    source = _source(channel=_saved_channel())
    await source.save()
    outcome = await DataDriver.loaded("slack").send(source, thread_key="100.000100", to=CHANNEL, text="on it", in_reply_to="100.000100")
    assert outcome.external_id == "300.000300" and outcome.recorded is True
    (row,) = await SourceItem.get_all({"data_source_id": str(source.id), "external_id": "300.000300"})
    assert row.sent_by_us, "on record at send, marked ours — the echo lands on this row"
    assert slack.requests[0] == "/chat.postMessage"
    assert json.loads(slack.bodies[0]) == {"channel": CHANNEL, "text": "on it", "thread_ts": "100.000100"}


async def test_send_stamps_the_bots_own_identity_once(serve):
    from flow_sdk.stream_inbox.projection import is_self_address

    serve([{"ok": True, "ts": "1.1"}, {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"}])
    source = _source(channel=_saved_channel())
    await source.save()
    await DataDriver.loaded("slack").send(source, thread_key="", to=CHANNEL, text="hi")
    assert source.account_key == "@flowpad"
    assert is_self_address(source, "UBOT") and is_self_address(source, "B1") and not is_self_address(source, "U1")


async def test_a_refused_post_is_a_value_error_not_source_health(serve):
    serve([{"ok": False, "error": "not_in_channel"}])
    with pytest.raises(ValueError, match="not_in_channel"):
        await DataDriver.loaded("slack").send(_source(), thread_key="", to=CHANNEL, text="hi")


async def test_send_without_a_channel_or_text_is_refused_before_any_request(serve):
    slack = serve([{"ok": True}])
    with pytest.raises(ValueError):
        await DataDriver.loaded("slack").send(_source(), thread_key="1.1", to="", text="hi")
    with pytest.raises(ValueError):
        await DataDriver.loaded("slack").send(_source(), thread_key="1.1", to=CHANNEL, text="  ")
    assert slack.requests == []


@pytest.fixture
def post_as(serve, monkeypatch):
    """Post from a source owned by ``agent``; returns (payload, outcome)."""

    async def _run(agent):
        async def _get(_id):
            return agent

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _get)
        slack = serve([{"ok": True, "ts": "300.000300", "channel": CHANNEL}, {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"}])
        source = _source(channel=_saved_channel(), agent_id="a-1")
        await source.save()
        outcome = await DataDriver.loaded("slack").send(source, thread_key="100.000100", to=CHANNEL, text="on it")
        return json.loads(slack.bodies[0]), outcome

    return _run


async def test_send_posts_as_the_agent_that_owns_the_source(post_as):
    posted, _ = await post_as(SimpleNamespace(name="slack-summarizer", avatar="\U0001f4ac"))
    assert (posted["username"], posted["icon_emoji"]) == ("slack-summarizer", ":speech_balloon:")


async def test_a_non_emoji_avatar_sends_a_name_and_never_an_icon(post_as):
    posted, _ = await post_as(SimpleNamespace(name="researcher", avatar="./avatar.png"))
    assert posted["username"] == "researcher" and "icon_emoji" not in posted and "icon_url" not in posted


async def test_a_missing_agent_row_still_posts(post_as):
    posted, outcome = await post_as(None)
    assert outcome.external_id == "300.000300" and "username" not in posted


# ── reuse and reply shape (the row and the outbound spec) ────────────────────


async def test_find_for_account_matches_the_rows_channel():
    mine = _saved_channel()
    row = _source(channel=mine)
    await row.save()
    try:
        found = await DataSource.find_for_account("slack", DataDriver.loaded("slack").cls.identity_config_key, mine)
        assert found is not None and found.id == row.id
        assert await DataSource.find_for_account("slack", "channel", _saved_channel()) is None
    finally:
        await row.delete()


async def test_slack_message_spec_replies_into_the_channel_thread():
    from flow_sdk.builtin.source_item import SlackMessageSpec

    ingested = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL}))._message_origin("100.000100", CHANNEL)
    m = SimpleNamespace(origin_namespace=ingested.namespace, thread_key="100.000100", external_id="100.000100", author_external_id="U1", name="", body="ship it?")
    r = SlackMessageSpec.reply_to(m, body="shipping")
    assert (r.to, r.thread_key, r.reply_to_external_id) == ([CHANNEL], "100.000100", "100.000100")
    assert DataDriver.loaded("slack").outbound_spec(_source()) is SlackMessageSpec
