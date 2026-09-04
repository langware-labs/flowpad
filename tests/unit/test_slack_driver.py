"""The Slack driver, against a real socket serving Slack's own response shapes.

Slack is the provider that breaks the assumptions the first three drivers were
written under, and every test here pins one of the breaks:

* it answers **200 with `ok: false`**, so the status code never says whether a
  call worked;
* it will not let an app read a channel nobody invited it to, which is a SETUP
  state and not a failure;
* it allows **one history request a minute**, which is why the driver reads one
  page of one channel per poll and paginates never.

A stubbed httpx client would let all three pass while broken, so this uses the
same loopback server the other driver tests do.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers import slack as slack_module
from flow_sdk.ingest.drivers.slack import SlackDriver
from flow_sdk.ingest.health import SourceError, SourceHealth
from tests.unit._ingest_helpers import local_http_server

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

CHANNEL = "C0123456789"


def _source(**config) -> DataSource:
    return DataSource(
        provider="slack",
        name="Slack test",
        config={"channels": [CHANNEL], **config},
    )


def _view(state: dict | None = None, window_start: str | None = None) -> SegmentCursorView:
    return SegmentCursorView(
        segment_key=CHANNEL,
        state=state or {},
        window_start=window_start,
        first_run=not state,
    )


def _message(ts: str, text: str, **extra) -> dict:
    return {"type": "message", "user": "U1", "ts": ts, "text": text, **extra}


class _Slack:
    """A Slack that records what it was asked and answers what it is told to."""

    def __init__(self, replies: list[dict]):
        self.replies = replies
        self.requests: list[str] = []
        self.bodies: list[str] = []

    def __call__(self, path, headers):
        self.requests.append(path)
        self.bodies.append(str(headers.get("_body") or ""))
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        # 200 even for errors — Slack's convention, and the whole point.
        return 200, json.dumps(reply).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def serve(monkeypatch, request):
    """Point the driver at a local Slack that replies with `replies` in order.

    A fixture rather than a plain helper so the socket is closed on teardown —
    a leaked server per test would outlive the run.
    """

    def _factory(replies: list[dict]) -> _Slack:
        slack = _Slack(replies)
        server = local_http_server(slack)
        monkeypatch.setattr(slack_module, "SLACK_API_BASE", server.__enter__())
        monkeypatch.setattr(SlackDriver, "_token", lambda self, source: _ready("xoxp-test"))
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return slack

    return _factory


async def _ready(value):
    return value


# ── streams ──────────────────────────────────────────────────────────────────


async def test_streams_key_on_the_channel_id_not_its_name():
    """A rename is the same channel. Keyed on the name it would fork its history
    and every message would re-ingest as new."""
    driver = SlackDriver()
    source = _source()
    source.config = {"channels": [{"id": CHANNEL, "name": "engineering"}]}

    (stream,) = await driver.segments(source)
    assert stream.key == CHANNEL
    assert stream.label == "engineering"


async def test_a_bare_string_channel_is_accepted_as_the_id():
    (stream,) = await SlackDriver().segments(_source())
    assert stream.key == CHANNEL


# ── fetch ────────────────────────────────────────────────────────────────────


async def test_a_page_becomes_items_oldest_first(serve):
    """Slack returns newest-first. Ingested in that order a conversation reads
    backwards, so the driver reverses before handing anything on."""
    serve(
        [
            {
                "ok": True,
                "messages": [_message("200.000200", "second"), _message("100.000100", "first")],
            }
        ]
    )

    result = await SlackDriver().fetch(_source(), _view())

    assert [i.body for i in result.items] == ["first", "second"]
    assert [i.external_id for i in result.items] == ["100.000100", "200.000200"]
    assert result.items[0].occurred_at == datetime.fromtimestamp(100.0001, tz=timezone.utc).isoformat()


async def test_the_cursor_resumes_from_the_last_ts(serve):
    """`ts` is both the timestamp and the message id, so it is the resume point
    — and `inclusive=false` means the last message read is never re-fetched."""
    slack = serve([{"ok": True, "messages": [_message("300.0", "next")]}])

    result = await SlackDriver().fetch(_source(), _view(state={"last_ts": "200.000200"}))

    assert "oldest=200.000200" in slack.requests[0]
    assert "inclusive=false" in slack.requests[0]
    assert result.next_state["last_ts"] == "300.0"


async def test_ts_advances_numerically_not_lexically(serve):
    """ "90" > "100" as strings. Sorted that way the cursor would go BACKWARDS
    and the same page would re-fetch forever."""
    serve(
        [
            {
                "ok": True,
                "messages": [_message("100.000000", "newer"), _message("90.000000", "older")],
            }
        ]
    )

    result = await SlackDriver().fetch(_source(), _view(state={"last_ts": "89.0"}))

    assert result.next_state["last_ts"] == "100.000000"


async def test_the_first_run_is_bounded_by_the_window(serve):
    """Without this a new source pulls a channel's entire history on the tick it
    was created — and at 15 messages a minute it would never finish."""
    slack = serve([{"ok": True, "messages": []}])

    await SlackDriver().fetch(_source(), _view(window_start="2026-08-01T00:00:00+00:00"))

    assert "oldest=1785542400.000000" in slack.requests[0]


async def test_it_asks_for_one_page_and_never_paginates(serve):
    """One request per poll is the entire minute's budget. A second page here
    would 429 — and the driver would have spent the next poll's budget too."""
    slack = serve(
        [
            {
                "ok": True,
                "messages": [_message(f"{n}.0", str(n)) for n in range(15)],
                "has_more": True,
                "response_metadata": {"next_cursor": "dXNlcjpVMDYxTkZUVDI="},
            }
        ]
    )

    result = await SlackDriver().fetch(_source(), _view())

    assert len(slack.requests) == 1, "paginated into the next minute's budget"
    assert "limit=15" in slack.requests[0]
    assert len(result.items) == 15


async def test_an_empty_page_reports_unchanged(serve):
    """Distinct from "fetched nothing": `unchanged` is what keeps an idle
    channel from re-writing its cursor and re-firing anything downstream."""
    serve([{"ok": True, "messages": []}])

    result = await SlackDriver().fetch(_source(), _view(state={"last_ts": "1.0"}))

    assert result.unchanged is True
    assert result.items == []
    assert result.next_state == {"last_ts": "1.0"}, "an idle poll moved the cursor"


async def test_joins_and_leaves_are_not_messages(serve):
    """They are real events, but nobody wrote them — each would land in the
    inbox as a conversation entry with no author and no content."""
    serve(
        [
            {
                "ok": True,
                "messages": [
                    _message("100.0", "hello"),
                    _message("110.0", "x joined", subtype="channel_join"),
                    _message("120.0", "renamed", subtype="channel_name"),
                ],
            }
        ]
    )

    result = await SlackDriver().fetch(_source(), _view())

    assert [i.body for i in result.items] == ["hello"]
    # ...but the cursor still passes them, or every poll re-reads the join.
    assert result.next_state["last_ts"] == "120.0"


async def test_a_threaded_reply_joins_its_parents_thread(serve):
    """Both messages must resolve to ONE conversation — the thread key is what
    the inbox projection groups on."""
    # Newest-first, the way Slack actually answers.
    serve(
        [
            {
                "ok": True,
                "messages": [
                    _message("150.0", "reply", thread_ts="100.0"),
                    _message("100.0", "parent"),
                ],
            }
        ]
    )

    parent, reply = (await SlackDriver().fetch(_source(), _view())).items

    assert parent.thread_key == "100.0"
    assert reply.thread_key == "100.0"
    assert reply.reply_to_external_id == "100.0"
    assert parent.reply_to_external_id is None, "a top-level message replies to nothing"


async def test_the_permalink_is_a_formula_not_a_fetch(serve):
    """`permalink` is DIGESTED: a `chat.getPermalink` per message would spend a
    request per message against a one-per-minute budget, and any drift in it
    would rewrite the whole corpus on the next poll."""
    slack = serve([{"ok": True, "messages": [_message("100.0", "hi")]}])

    (item,) = (await SlackDriver().fetch(_source(), _view())).items

    assert item.permalink == f"https://slack.com/app_redirect?channel={CHANNEL}&message_ts=100.0"
    assert len(slack.requests) == 1


# ── Slack's failure convention ───────────────────────────────────────────────


async def test_a_200_with_ok_false_is_a_failure(serve):
    """The trap this provider sets. Read as a success it becomes an empty page,
    so a revoked token reads as a quiet workspace — forever."""
    serve([{"ok": False, "error": "invalid_auth"}])

    with pytest.raises(SourceError) as caught:
        await SlackDriver().fetch(_source(), _view())

    assert caught.value.health is SourceHealth.CONFIG_ERROR
    assert caught.value.code == "invalid_auth"


async def test_rate_limiting_is_transient_not_a_config_error(serve):
    """A config error PARKS the source until a person clears it. Classified that
    way, one throttle would stop a working Slack source permanently."""
    serve([{"ok": False, "error": "ratelimited"}])

    with pytest.raises(SourceError) as caught:
        await SlackDriver().fetch(_source(), _view())

    assert caught.value.health is SourceHealth.TRANSIENT_ERROR


async def test_not_in_channel_says_what_to_do_about_it(serve):
    serve([{"ok": False, "error": "not_in_channel"}])

    with pytest.raises(SourceError) as caught:
        await SlackDriver().fetch(_source(), _view())

    assert "invite" in str(caught.value).lower()


async def test_no_credential_is_reported_before_any_request(monkeypatch):
    monkeypatch.setattr(SlackDriver, "_token", lambda self, source: _ready(None))

    with pytest.raises(SourceError) as caught:
        await SlackDriver().fetch(_source(), _view())

    assert caught.value.code == "no_credential"


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_passes_when_every_channel_reads(serve):
    serve([{"ok": True, "messages": []}])

    verdict = await SlackDriver().verify(_source())

    assert verdict.ready is True


async def test_verify_is_all_or_nothing_across_channels(serve):
    """A source ingesting three of five channels is worse than one that refuses
    to start: it looks like it works, so nobody looks for the missing two."""
    source = _source()
    source.config = {"channels": [CHANNEL, "C9999999999"]}
    serve(
        [
            {"ok": True, "messages": []},
            {"ok": False, "error": "not_in_channel"},
        ]
    )

    verdict = await SlackDriver().verify(source)

    assert verdict.ready is False
    assert verdict.pending == ("C9999999999",)
    assert "C9999999999" in verdict.detail


async def test_verify_separates_a_missing_scope_from_a_missing_invite(serve):
    """Inviting the bot cannot fix a missing scope — reporting it as an invite
    problem sends the user to do work that changes nothing."""
    serve([{"ok": False, "error": "missing_scope"}])

    verdict = await SlackDriver().verify(_source())

    assert verdict.ready is False
    assert verdict.pending == ()
    assert "channels:history" in verdict.detail


async def test_verify_refuses_a_source_with_no_channels():
    """Zero channels is not an empty source, it is one that can never ingest:
    `streams()` returns nothing, so no cursor is ever created."""
    source = _source()
    source.config = {"channels": []}

    verdict = await SlackDriver().verify(source)

    assert verdict.ready is False
    assert "channel" in verdict.detail.lower()


# ── send ─────────────────────────────────────────────────────────────────────


async def test_send_posts_into_the_thread_and_returns_the_ts(serve):
    """``to`` is the channel, ``thread_key`` becomes ``thread_ts``; the outcome
    carries Slack's ``ts`` — the same namespace an inbound ``external_id``
    lives in, so the echoed copy converges on it."""
    slack = serve(
        [
            {"ok": True, "ts": "300.000300", "channel": CHANNEL},
            {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"},
        ]
    )
    source = _source()
    await source.save()

    outcome = await SlackDriver().send(
        source, thread_key="100.000100", to=CHANNEL, text="on it", in_reply_to="100.000100"
    )

    assert outcome.external_id == "300.000300"
    assert outcome.recorded is False, "Slack echoes bot posts; the driver must not record a second copy"
    assert slack.requests[0] == "/chat.postMessage"
    posted = json.loads(slack.bodies[0])
    assert posted == {"channel": CHANNEL, "text": "on it", "thread_ts": "100.000100"}


async def test_send_stamps_the_bots_own_identity_once(serve):
    """After a send the source knows who "me" is, so the echoed copy is
    attributed as ours and a listening loop never answers itself."""
    from flow_sdk.inbox.projection import is_self_address

    serve(
        [
            {"ok": True, "ts": "1.1"},
            {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"},
        ]
    )
    source = _source()
    await source.save()

    await SlackDriver().send(source, thread_key="", to=CHANNEL, text="hi")

    assert source.account_key == "@flowpad"
    assert is_self_address(source, "UBOT")
    assert is_self_address(source, "B1")
    assert not is_self_address(source, "U1")


async def test_a_refused_post_is_a_value_error_not_source_health(serve):
    serve([{"ok": False, "error": "not_in_channel"}])
    source = _source()
    with pytest.raises(ValueError, match="not_in_channel"):
        await SlackDriver().send(source, thread_key="", to=CHANNEL, text="hi")


async def test_send_without_a_channel_or_text_is_refused_before_any_request(serve):
    slack = serve([{"ok": True}])
    with pytest.raises(ValueError):
        await SlackDriver().send(_source(), thread_key="1.1", to="", text="hi")
    with pytest.raises(ValueError):
        await SlackDriver().send(_source(), thread_key="1.1", to=CHANNEL, text="  ")
    assert slack.requests == []


# ── identity / reuse ─────────────────────────────────────────────────────────


async def test_a_bare_string_channels_config_names_one_channel():
    """``blocks.Inbox("C0…", provider="slack")`` writes ``channels`` as a
    string; iterated raw it would yield the id's characters as channels."""
    source = DataSource(provider="slack", name="s", config={"channels": CHANNEL})
    (stream,) = await SlackDriver().segments(source)
    assert stream.key == CHANNEL


async def test_find_for_account_matches_a_channel_inside_the_list():
    import uuid

    from flow_sdk.builtin.data_source import DataSource as DS

    mine = "C0" + uuid.uuid4().hex[:9].upper()
    row = _source()
    row.config = {"channels": ["C0AAAAAAAAA", mine]}
    await row.save()
    try:
        found = await DS.find_for_account("slack", "channels", mine)
        assert found is not None and found.id == row.id
        assert await DS.find_for_account("slack", "channels", "C0" + uuid.uuid4().hex[:9].upper()) is None
    finally:
        await row.delete()


async def test_slack_message_spec_replies_into_the_channel_thread():
    from types import SimpleNamespace

    from flow_sdk.builtin.source_item import SlackMessageSpec

    m = SimpleNamespace(
        segment_key=CHANNEL,
        thread_key="100.000100",
        external_id="100.000100",
        author_external_id="U1",
        name="",
        body="ship it?",
    )
    r = SlackMessageSpec.reply_to(m, body="shipping")
    assert r.to == [CHANNEL]
    assert r.thread_key == "100.000100"
    assert r.reply_to_external_id == "100.000100"
    with pytest.raises(Exception):
        r.body = "edited"


@pytest.fixture
def post_as(serve, monkeypatch):
    """Post from a source owned by `agent`; returns (payload, outcome).

    The three identity tests differ only in the Agent row and the assertions,
    and this file already keeps its setup in helpers (`serve`, `_source`,
    `_view`) for exactly that reason.
    """

    async def _run(agent):
        async def _get(_id):
            return agent

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _get)
        slack = serve(
            [
                {"ok": True, "ts": "300.000300", "channel": CHANNEL},
                {"ok": True, "user_id": "UBOT", "bot_id": "B1", "user": "flowpad"},
            ]
        )
        source = _source(agent_id="a-1")
        await source.save()
        outcome = await SlackDriver().send(source, thread_key="100.000100", to=CHANNEL, text="on it")
        return json.loads(slack.bodies[0]), outcome

    return _run


async def test_send_posts_as_the_agent_that_owns_the_source(post_as):
    """The demo, at the payload level: the post carries the agent's name and emoji.

    Resolved from `config["agent_id"]` — the same key the INBOUND half already
    reads — so a channel shows one identity for an agent, not one name in
    Flowpad and another in Slack.
    """
    posted, _ = await post_as(SimpleNamespace(name="slack-summarizer", avatar="\U0001f4ac"))

    assert posted["username"] == "slack-summarizer"
    assert posted["icon_emoji"] == ":speech_balloon:"


async def test_a_non_emoji_avatar_sends_a_name_and_never_an_icon_url(post_as):
    """An uploaded avatar lives at 127.0.0.1 behind auth; Slack fetches
    ``icon_url`` from its own network, so there is nothing to point at. Sending
    one would be a broken image on every post."""
    posted, _ = await post_as(SimpleNamespace(name="researcher", avatar="./avatar.png"))

    assert posted["username"] == "researcher"
    assert "icon_emoji" not in posted
    assert "icon_url" not in posted


async def test_a_missing_agent_row_still_posts(post_as):
    """Identity is a nicety — exactly how `_ensure_identity` already treats it."""
    posted, outcome = await post_as(None)

    assert outcome.external_id == "300.000300"
    assert "username" not in posted
