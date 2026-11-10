"""The ``slack`` data source, against a real socket serving Slack's own response shapes.

Slack breaks the assumptions the first sources were written under, and these pin each break:
it answers **200 with ``ok: false``**; it will not let an app read a channel nobody invited it
to, which is a SETUP state; and it allows **one history request a minute**, so a pass reads one
page of the channel. A stubbed client would let all three pass while broken.
"""
from __future__ import annotations

import itertools
import json
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode

import pytest
from pydantic import SecretStr

from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.blocks.merge import pages
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.consumer_position import ConsumerPosition
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.envelope_lift import envelope_of
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.schema.types import EntityType
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.files import local_file
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import (
    FileItem,
    FileKind,
    MessageData,
    MessageFileData,
    MessageItem,
    ReactionData,
    ReactionMode,
)
from flow_sdk.stream_inbox.projection import channel_of, owner_of, resolve_thread, thread_key_for

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


def _source(*, identified: bool = True, **config) -> DataSource:
    """A source that already knows who it reads as (as a verified one does), so a traverse goes
    straight to the channel instead of asking ``auth.test`` first; ``identified=False`` for one
    that does not know yet."""
    return DataSource(provider="slack", name=f"Slack test {uuid.uuid4().hex[:8]}", account_key="@flowpad-bot" if identified else "",
                      config={"channel": CHANNEL, "base_url": BASE, **config})


def _view(cursor: str | None = None, window_start: str | None = None):
    return position(cursor=cursor, window_start=window_start)


def _message(ts: str, text: str, **extra) -> dict:
    return {"type": "message", "user": "U1", "ts": ts, "text": text, **extra}


def _credentials(token):
    async def resolve(_row):
        return ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else ResolvedSecrets()

    return resolve


@pytest.fixture(autouse=True)
def _a_token(monkeypatch):
    monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", _credentials("xoxp-test"))


class _Slack:
    """A Slack that records what it was asked and answers what it is told to."""

    def __init__(self, replies: list[dict]):
        self.replies, self.requests, self.bodies, self.auths = replies, [], [], []

    def __call__(self, path, headers):
        self.requests.append(path)
        self.auths.append(str(headers.get("Authorization") or ""))
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
    ``chat.postMessage`` and completed upload it accepted, in order; ``arrive`` is a message someone
    else wrote. Files go up in Slack's three steps and come down through ``files.info``; reactions
    live on the history's messages, the bot reacting as ``UBOT``."""

    #: ``auth.test`` refuses every token with this error (``invalid_auth``); empty: every token is accepted.
    refuse = ""
    #: Who the token is — ``auth.test``'s ``user_id``, and the reactor of every ``reactions.add``.
    me = "UBOT"

    def __init__(self):
        self.clock = 300.0
        self.channels = {"C1": [_message("100.000100", "root"), _message("150.000150", "in thread", thread_ts="100.000100"), _message("200.000200", "later")]}
        self.posts: list[dict] = []
        #: ``users.info``'s handle per member id; a member not here has no profile.
        self.people: dict[str, str] = {"U1": "dana", self.me: "flowpad"}
        #: file id → {name, length, bytes}: every file that exists here, uploaded or arrived.
        self.files: dict[str, dict] = {}
        #: The Authorization header of every download.
        self.downloads: list[str] = []
        self.calls: list[tuple[str, dict]] = []

    def fresh_ts(self) -> str:
        """A ts later than every one handed out so far and never behind the wall clock, so a
        message written now lands after a resume cursor taken a moment ago."""
        self.clock = max(time.time(), self.clock + 0.000001)
        return f"{self.clock:.6f}"

    def arrive(self, channel: str, text: str, *, user: str, thread_ts: str | None = None, files: tuple = (), reactions: dict | None = None) -> dict:
        """``files``: ``(name, bytes)`` pairs the message carries; ``reactions``: ``{name: [user, ...]}``."""
        extra: dict = {"thread_ts": thread_ts} if thread_ts else {}
        if files:
            extra["files"] = [self._file_entry(self._store_file(name, content)) for name, content in files]
        if reactions:
            extra["reactions"] = [{"name": n, "users": list(u), "count": len(u)} for n, u in reactions.items()]
        message = {**_message(self.fresh_ts(), text, **extra), "user": user}
        self.channels.setdefault(channel, []).append(message)
        return message

    def _store_file(self, name: str, content: bytes | None = None, length: int | None = None) -> str:
        file_id = f"F{len(self.files) + 1:08d}"
        self.files[file_id] = {"name": name, "length": len(content) if content is not None else length, "bytes": content}
        return file_id

    def _file_entry(self, file_id: str, host: str = "") -> dict:
        import mimetypes

        f = self.files[file_id]
        entry = {"id": file_id, "name": f["name"], "title": f["name"], "mimetype": mimetypes.guess_type(f["name"])[0] or "application/octet-stream",
                 "size": len(f["bytes"] or b""), "permalink": f"https://example.slack.com/files/{file_id}"}
        if host:
            entry["url_private_download"] = f"http://{host}/download/{file_id}"
        return entry

    def message(self, channel: str, ts: str) -> dict:
        return next(m for m in self.channels[channel] if m["ts"] == ts)

    def _conversation(self, channel: str) -> dict:
        """``users.conversations``'s entry: the kind by the id's letter, ``updated`` its newest message."""
        kind = {"D": {"is_im": True}, "G": {"is_mpim": True, "is_private": True}}.get(channel[0], {"is_channel": True})
        newest = max((float(m["ts"]) for m in self.channels[channel]), default=0.0)
        return {"id": channel, "name": channel.lower(), "updated": int(newest * 1000), **kind}

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        method = route.lstrip("/")
        host = str(headers.get("Host") or "")
        if method.startswith("upload/"):
            self.files[method.split("/", 1)[1]]["bytes"] = headers["_raw"]
            return 200, b"OK - 5", {"Content-Type": "text/plain"}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        self.calls.append((method, params or body))
        if method == "auth.test":
            if self.refuse:
                return self._ok(ok=False, error=self.refuse)
            return self._ok(user_id=self.me, bot_id="B1", user="flowpad", team_id="T1")
        if method == "users.conversations":
            rows = [self._conversation(c) for c in sorted(self.channels)]
            start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 100)
            more = start + limit < len(rows)
            return self._ok(channels=rows[start:start + limit], response_metadata={"next_cursor": str(start + limit) if more else ""})
        if method == "users.info":
            name = self.people.get(params.get("user") or "")
            return self._ok(user={"id": params.get("user"), "name": name}) if name else self._ok(ok=False, error="user_not_found")
        if method.startswith("download/"):
            self.downloads.append(str(headers.get("Authorization") or ""))
            f = self.files.get(method.split("/", 1)[1])
            return (200, f["bytes"], {"Content-Type": "application/octet-stream"}) if f else (404, b"", {})
        if method == "files.getUploadURLExternal":
            file_id = self._store_file(params["filename"], length=int(params["length"]))
            return self._ok(upload_url=f"http://{host}/upload/{file_id}", file_id=file_id)
        if method == "files.info":
            if params.get("file") not in self.files:
                return self._ok(ok=False, error="file_not_found")
            return self._ok(file=self._file_entry(params["file"], host))
        if method == "files.completeUploadExternal":
            return self._complete(body)
        if method.startswith("reactions."):
            return self._react(method, params or body)
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
        if method == "conversations.replies":
            return self._thread(channel, params)
        rows = sorted((self._listed(channel, m) for m in self.channels[channel] if not self._is_reply(m)), key=lambda m: float(m["ts"]), reverse=True)
        if "latest" in params:
            inclusive = params.get("inclusive") not in ("false", "0")
            rows = [m for m in rows if float(m["ts"]) < float(params["latest"]) or (inclusive and float(m["ts"]) == float(params["latest"]))]
        if "oldest" in params:
            rows = [m for m in rows if float(m["ts"]) > float(params["oldest"])]
        start, limit = int(params.get("cursor") or 0), int(params.get("limit") or 100)
        more = start + limit < len(rows)
        return self._ok(messages=rows[start:start + limit], response_metadata={"next_cursor": str(start + limit) if more else ""})

    @staticmethod
    def _is_reply(message: dict) -> bool:
        """A thread reply: ``conversations.history`` leaves it out unless it was also sent to the channel."""
        return message.get("thread_ts") not in (None, message["ts"]) and message.get("subtype") != "thread_broadcast"

    def _listed(self, channel: str, root: dict) -> dict:
        """``root`` as history lists it: a thread's count and newest reply on it, the replies themselves not."""
        replies = [m["ts"] for m in self.channels[channel] if m.get("thread_ts") == root["ts"] and m["ts"] != root["ts"]]
        return {**root, "thread_ts": root["ts"], "reply_count": len(replies), "latest_reply": max(replies, key=float)} if replies else root

    def _thread(self, channel: str, params: dict):
        """``conversations.replies``: the root whatever ``oldest`` says, then its replies after it, oldest first."""
        root, floor = params["ts"], float(params.get("oldest") or 0)
        rows = sorted((m for m in self.channels[channel] if m["ts"] == root or m.get("thread_ts") == root), key=lambda m: float(m["ts"]))
        return self._ok(messages=[m for m in rows if m["ts"] == root or float(m["ts"]) > floor], response_metadata={"next_cursor": ""})

    def _complete(self, body: dict):
        channel, thread = body.get("channel_id"), body.get("thread_ts") or None
        if channel not in self.channels:
            return self._ok(ok=False, error="channel_not_found")
        ids = [f["id"] for f in body["files"]]
        if any(self.files[i]["bytes"] is None or len(self.files[i]["bytes"]) != self.files[i]["length"] for i in ids):
            return self._ok(ok=False, error="upload_incomplete")
        ts, text = self.fresh_ts(), body.get("initial_comment") or ""
        extra = {"thread_ts": thread} if thread else {}
        self.channels[channel].append({**_message(ts, text, **extra), "user": self.me, "files": [self._file_entry(i) for i in ids]})
        self.posts.append({"to": channel, "text": text, "thread": thread, "external_id": ts,
                           "files": [(self.files[i]["name"], self.files[i]["bytes"]) for i in ids]})
        return self._ok(files=[{"id": i, "title": self.files[i]["name"]} for i in ids])

    def _react(self, method: str, args: dict):
        channel, ts = args.get("channel"), args.get("timestamp")
        found = [m for m in self.channels.get(channel, []) if m["ts"] == ts]
        if not found:
            return self._ok(ok=False, error="message_not_found")
        reactions = found[0].setdefault("reactions", [])
        if method == "reactions.get":
            return self._ok(type="message", message=found[0])
        entry = next((r for r in reactions if r["name"] == args["name"]), None)
        if method == "reactions.add":
            if entry is not None and self.me in entry["users"]:
                return self._ok(ok=False, error="already_reacted")
            if entry is None:
                reactions.append(entry := {"name": args["name"], "users": [], "count": 0})
            entry["users"].append(self.me)
        else:
            if entry is None or self.me not in entry["users"]:
                return self._ok(ok=False, error="no_reaction")
            entry["users"].remove(self.me)
            if not entry["users"]:
                reactions.remove(entry)
        if entry in reactions:
            entry["count"] = len(entry["users"])
        return self._ok()

    @staticmethod
    def _ok(ok=True, **fields):
        return 200, json.dumps({"ok": ok, **fields}).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def fake_slack():
    slack = _FakeSlack()
    with local_http_server(slack) as base:
        yield SimpleNamespace(base=base, slack=slack)


def _binding(base: str) -> SourceBinding:
    return SourceBinding(
        account_key="T1",
        config={"channel": "C1", "base_url": base},
        credentials=ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr("xoxb-test")),
    )


@pytest.mark.parametrize("check", checks_for(SlackSource), ids=str)
async def test_conformance(check, fake_slack):
    binding = _binding(fake_slack.base)
    probe = SlackSource(binding)
    file_id = fake_slack.slack._store_file("notes.txt", b"handed out")
    await check.run(Subject(
        source=lambda: SlackSource(binding),
        seeded=tuple(probe.origin(ts, "C1") for ts in ("100.000100", "200.000200")),  # 150 is a reply: not in a first read
        conversation=probe.origin("100.000100", "C1"),
        recipient=UserProfile(origin=probe.origin("U1"), name="Ada"),
        inbound_file=FileItem(origin=probe.origin(file_id, "C1"), data=MessageFileData(name="notes.txt")),
        inbound_bytes=b"handed out",
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
    slack = serve([{"ok": True, "messages": [_message("300.0", "next"), _message("200.000200", "read")]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("200.000200")))
    assert len(slack.requests) == 1 and "oldest" not in slack.requests[0], "a resumed pass is one call: the newest page"
    assert [i.body for i in result.items] == ["next"], "a message at the position came back"
    assert result.cursor == "resume:300.0|replies:200.000200"


async def test_new_messages_past_a_page_are_paged_from_the_position(serve):
    full = {"ok": True, "messages": [_message(f"{n}.0", str(n)) for n in range(315, 300, -1)], "response_metadata": {"next_cursor": "more"}}
    slack = serve([full, full])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("200.000200")))
    assert "oldest" not in slack.requests[0] and "oldest=200.000200" in slack.requests[1], "the page cursor does not stop at the position"
    assert len(result.items) == 15


async def test_ts_advances_numerically_not_lexically(serve):
    serve([{"ok": True, "messages": [_message("100.000000", "newer"), _message("90.000000", "older")]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("89.0")))
    assert result.cursor == "resume:100.000000|replies:89.0"


async def test_the_first_run_is_bounded_by_the_window(serve):
    slack = serve([{"ok": True, "messages": []}])
    await DataDriver.loaded("slack").traverse(_source(), _view(window_start="2026-08-01T00:00:00+00:00"))
    assert "oldest=1785542400.000000" in slack.requests[0]


async def test_a_backward_read_asks_for_history_before_the_bound_newest_first(serve):
    slack = serve([{"ok": True, "messages": [_message("150.000150", "middle"), _message("100.000100", "first")]}])
    source = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL, "base_url": BASE},
                                       credentials=ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr("xoxb-test"))))
    async with source:
        page = await source.fetch(None, page_size=2, narrow={"before": datetime.fromtimestamp(200.0002, tz=timezone.utc)})
    query = parse_qs(slack.requests[0].split("?", 1)[1])
    assert query["latest"] == ["200.000200"] and query["inclusive"] == ["false"] and query["limit"] == ["2"]
    assert "oldest" not in query and "cursor" not in query, "a backward read ignores the window and the forward cursor"
    assert [i.data.text for i in page.items] == ["middle", "first"]
    assert page.next_cursor is None and page.resume_cursor is None


async def test_a_backward_read_over_the_double_lists_only_older_and_leaves_the_forward_read_alone(fake_slack):
    source = SlackSource(_binding(fake_slack.base))
    async with source:
        forward = await source.fetch()
        older = await source.fetch(None, page_size=5, narrow={"before": datetime.fromtimestamp(200.0002, tz=timezone.utc)})
        again = await source.fetch()
    assert [i.origin.key for i in older.items] == ["100.000100"], "a thread's reply is not in the channel's history"
    assert [i.origin.key for i in again.items] == [i.origin.key for i in forward.items]
    assert again.resume_cursor == forward.resume_cursor


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
    root = _message("100.0", "parent", thread_ts="100.0", reply_count=1, latest_reply="150.0")
    serve([{"ok": True, "messages": [root]}, {"ok": True, "messages": [root, _message("150.0", "reply", thread_ts="100.0")]}])
    parent, reply =(await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("90.0")))).items
    assert parent.thread_key == reply.thread_key == "100.0"
    assert parent.reply_to_external_id is None and reply.reply_to_external_id is None


async def test_a_late_reply_on_an_older_thread_is_read_once_and_joins_its_root(fake_slack):
    source = SlackSource(_binding(fake_slack.base))
    async with source:
        first = await source.fetch()
        late = fake_slack.slack.arrive("C1", "late", user="U2", thread_ts="100.000100")
        second = await source.fetch(first.resume_cursor)
        third = await source.fetch(second.resume_cursor)
    assert {i.origin.key for i in first.items} == {"100.000100", "200.000200"}, "a first read is backfill: no replies"
    assert [(i.origin.key, i.data.conversation.key) for i in second.items] == [(late["ts"], "100.000100")]
    assert third.items == (), "a reply already read came back"


async def test_a_cursor_from_before_replies_were_read_hands_over_no_old_reply(fake_slack):
    """A row polled before this reader has no reply mark: the reply already in a thread is marked read, a later one is news."""
    source = SlackSource(_binding(fake_slack.base))
    async with source:
        upgraded = await source.fetch("resume:120.0")  # the in-thread reply at 150 is past the position, and old
        late = fake_slack.slack.arrive("C1", "late", user="U2", thread_ts="100.000100")
        after = await source.fetch(upgraded.resume_cursor)
    assert [i.origin.key for i in upgraded.items] == ["200.000200"] and upgraded.resume_cursor == "resume:200.000200|replies:200.000200"
    assert [i.origin.key for i in after.items] == [late["ts"]]


@pytest.mark.parametrize("error", ["ratelimited", "invalid_ts_oldest"], ids=["rate-limited", "refused"])
async def test_a_failed_thread_read_keeps_the_channel_page_and_the_next_pass_reads_the_reply(serve, error):
    root = _message("100.0", "parent", thread_ts="100.0", reply_count=1, latest_reply="250.0")
    listing = {"ok": True, "messages": [_message("300.0", "next"), root]}
    serve([listing, {"ok": False, "error": error}, listing, {"ok": True, "messages": [root, _message("250.0", "reply", thread_ts="100.0")]}])
    first = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("200.000200")))
    assert [i.body for i in first.items] == ["next"] and first.cursor == "resume:300.0|replies:200.000200"
    second = await DataDriver.loaded("slack").traverse(_source(), _view(first.cursor))
    assert [i.body for i in second.items] == ["reply"]


async def test_a_thread_deleted_since_it_was_listed_is_skipped(serve):
    kept = _message("110.0", "kept", thread_ts="110.0", reply_count=1, latest_reply="260.0")
    gone = _message("100.0", "gone", thread_ts="100.0", reply_count=1, latest_reply="250.0")
    serve([{"ok": True, "messages": [kept, gone]}, {"ok": True, "messages": [kept, _message("260.0", "reply", thread_ts="110.0")]},
           {"ok": False, "error": "thread_not_found"}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("200.000200")))
    assert [i.body for i in result.items] == ["reply"] and result.cursor == "resume:200.000200|replies:260.0"


async def test_a_reply_also_sent_to_the_channel_is_one_item(serve):
    root = _message("100.0", "parent", thread_ts="100.0", reply_count=1, latest_reply="150.0")
    broadcast = _message("150.0", "also", thread_ts="100.0", subtype="thread_broadcast")
    serve([{"ok": True, "messages": [broadcast, root]}, {"ok": True, "messages": [root, broadcast]}])
    result = await DataDriver.loaded("slack").traverse(_source(), _view(SlackSource.resume_after("90.0")))
    assert [i.external_id for i in result.items] == ["100.0", "150.0"]


async def test_a_message_inside_a_thread_can_be_replied_to(fake_slack):
    source = SlackSource(_binding(fake_slack.base))
    async with source:
        await source.reply(source._message_origin("150.000150", "C1"), MessageData(text="answer"))
    assert fake_slack.slack.posts[-1]["thread"] == "100.000100"


async def test_a_listed_root_reaches_a_consumer_once_and_its_reply_next(serve):
    """A resumed pass lists the newest roots again, the one already read among them (and again once it has a
    reply): it is not read again, so the serve loop is never handed it twice. The reply after it is the proof
    that the drain is live, and that nothing old was handed over first."""
    now = time.time()  # inside the source's window: an older message is not ingested at all
    root_ts, reply_ts = f"{now - 60:.6f}", f"{now - 30:.6f}"
    root = _message(root_ts, "are you there?")
    threaded = {**root, "thread_ts": root_ts, "reply_count": 1, "latest_reply": reply_ts}
    reply = _message(reply_ts, "in the thread", thread_ts=root_ts)
    serve([
        {"ok": True, "messages": [root]},
        {"ok": True, "messages": [root]},
        {"ok": True, "messages": [threaded]}, {"ok": True, "messages": [threaded, reply]},
    ])
    source = _source(channel=_saved_channel())
    await source.save()
    source_id, name = str(source.id), f"agent-serve:{uuid.uuid4()}"

    async with workflow(name):
        await ConsumerPosition.ensure_for(name, source_id, baseline=None)
        drain = pages(StreamInbox.of(source), poll_every=0.01, poll=False)  # the call the serve loop makes

        await source.sync()
        first = await drain.__anext__()
        assert [m.body for m in first] == ["are you there?"]
        await first.ack()

        assert len((await source.sync()).outcomes) == 0, "the second pass read the listed root again"
        assert len(await SourceItem.get_all({"data_source_id": source_id})) == 1, "the second pass made a second row"

        await source.sync()
        assert [m.body for m in await drain.__anext__()] == ["in the thread"]
        await drain.aclose()


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
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "bot token" in str(caught.value)
    assert slack.requests == []


def _declared(choice: str, bot: str = "", signin: str = ""):
    async def resolve(_row):
        return ResolvedSecrets(
            shape=AuthShape.SECRETS,
            values={"SLACK_BOT_TOKEN": SecretStr(bot)} if bot else {},
            token=SecretStr(signin) if signin else None,
            choice=choice,
        )

    return resolve


@pytest.mark.parametrize(("choice", "sent"), [("bot", "xoxb-own-bot"), ("signin", "xoxp-person")])
async def test_the_credential_way_decides_who_the_source_acts_as(serve, monkeypatch, choice, sent):
    slack = serve([{"ok": True, "messages": []}])
    resolve = _declared(choice, bot="xoxb-own-bot", signin="xoxp-person")
    monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", resolve)
    await DataDriver.loaded("slack").traverse(_source(), _view())
    assert slack.auths and all(a == f"Bearer {sent}" for a in slack.auths)


async def test_a_bot_token_alone_is_enough(serve, monkeypatch):
    slack = serve([{"ok": True, "messages": []}])
    monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", _declared("bot", bot="xoxb-own-bot"))
    await DataDriver.loaded("slack").traverse(_source(), _view())
    assert slack.auths == ["Bearer xoxb-own-bot"] * len(slack.requests)


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


async def test_verify_of_everything_needs_a_persons_token_not_a_bots(serve):
    """No channel is EVERYTHING the person is in — which a bot token cannot read: ``auth.test`` names no user."""
    serve([{"ok": True, "bot_id": "B1", "team_id": "T1"}])
    source = _source()
    source.config = {"base_url": BASE}
    verdict = await DataDriver.loaded("slack").verify(source)
    assert verdict.ready is False and "xoxp-" in verdict.detail and "bot" in verdict.detail.lower()


async def test_verify_of_everything_names_the_missing_scopes_and_the_person_it_reads_as(serve):
    slack = serve([
        {"ok": True, "user_id": "U1", "user": "eran", "team_id": "T1"},
        {"ok": False, "error": "missing_scope"},
        {"ok": True, "user_id": "U1", "user": "eran", "team_id": "T1"},
        {"ok": True, "channels": [{"id": "D1", "is_im": True}]},
    ])
    source = _source()
    source.config = {"base_url": BASE}
    refused = await DataDriver.loaded("slack").verify(source)
    ready = await DataDriver.loaded("slack").verify(source)
    assert refused.ready is False and "im:history" in refused.detail and "reinstall" in refused.detail
    assert ready.ready is True and "@eran" in ready.detail and "DMs" in ready.detail
    assert [r.split("?")[0] for r in slack.requests] == ["/auth.test", "/users.conversations"] * 2


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
    source = _source(identified=False, channel=_saved_channel())
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
    from flow_sdk.builtin.source_item import ChannelMessageSpec
    ingested = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL}))._message_origin("100.000100", CHANNEL)
    m = SimpleNamespace(origin_namespace=ingested.namespace, thread_key="100.000100", external_id="100.000100", author_external_id="U1", name="", body="ship it?")
    r = ChannelMessageSpec.reply_to(m, body="shipping")
    assert (r.to, r.thread_key, r.reply_to_external_id) == ([CHANNEL], "100.000100", "100.000100")
    assert DataDriver.loaded("slack").outbound_spec(_source()) is ChannelMessageSpec


# ── files ────────────────────────────────────────────────────────────────────


@pytest.fixture
def double(monkeypatch):
    from pathlib import Path

    from flow_sdk.ingest.driver_registry import load_module

    with load_module(Path(__file__).parent, "matrix").Double(channel=_saved_channel()) as d:
        monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", d.credentials)
        yield d


def test_the_channel_declares_what_it_takes():
    assert SlackSource.files.kinds == {FileKind.IMAGE, FileKind.VIDEO, FileKind.AUDIO, FileKind.DOCUMENT}
    assert (SlackSource.files.per_message, SlackSource.files.caption_max) == (10, 0)
    assert SlackSource.quotes is False and SlackSource.reactions_per_actor == 0


async def test_files_go_up_in_three_steps_with_the_text_as_their_comment_in_the_thread(double, tmp_path):
    report, photo = tmp_path / "report.pdf", tmp_path / "site.jpg"
    report.write_bytes(b"%PDF-1.7 report")
    photo.write_bytes(b"\xff\xd8JPEG")
    source = _source(**double.config)
    await source.save()
    outcome = await DataDriver.loaded("slack").send(
        source, thread_key="100.000100", to=double.channel, text="the numbers", files=(local_file(report), local_file(photo))
    )
    (post,) = double.sent()
    assert post["files"] == [("report.pdf", b"%PDF-1.7 report"), ("site.jpg", b"\xff\xd8JPEG")], "the bytes that arrived are the file's"
    assert (post["text"], post["thread"]) == ("the numbers", "100.000100"), "one message: the text rides as initial_comment"
    methods = [m for m, _ in double.slack.calls]
    assert methods.count("files.getUploadURLExternal") == 2 and methods.count("files.completeUploadExternal") == 1
    assert "chat.postMessage" not in methods
    asked = [args for m, args in double.slack.calls if m == "files.getUploadURLExternal"]
    assert [(a["filename"], a["length"]) for a in asked] == [("report.pdf", "15"), ("site.jpg", "6")]
    assert outcome.external_id.startswith("file:F") and outcome.recorded is True
    rows = await SourceItem.get_all({"data_source_id": str(source.id)})
    assert rows == [], "no copy at send: Slack names no ts for an upload, so the echo is the record"


async def test_a_files_only_send_has_no_comment_and_lands_top_level(double, tmp_path):
    clip = tmp_path / "clip.mp3"
    clip.write_bytes(b"ID3")
    source = _source(**double.config)
    await source.save()
    await DataDriver.loaded("slack").send(source, thread_key="", to=double.channel, text="", files=(local_file(clip),))
    (_, done), = [c for c in double.slack.calls if c[0] == "files.completeUploadExternal"]
    assert "initial_comment" not in done and "thread_ts" not in done and done["channel_id"] == double.channel


async def test_a_foreign_file_or_an_empty_message_is_refused_before_any_request(fake_slack):
    from flow_sdk.sources.values.items import MessageData

    async with SlackSource(_binding(fake_slack.base)) as s:
        conversation = s.channel_origin("C1")
        foreign = FileItem(origin=s.origin("F1", "C1"), data=MessageFileData(name="x"))
        with pytest.raises(ValueError):
            await s.send(MessageData(conversation=conversation, attachments=(foreign,)))
        with pytest.raises(ValueError):
            await s.send(MessageData(text=" ", conversation=conversation))
    assert fake_slack.slack.calls == []


async def test_inbound_files_are_mapped_and_their_bytes_read_with_the_token(fake_slack):
    slack = fake_slack.slack
    slack.arrive("C1", "see attached", user="U2", files=(("plan.png", b"\x89PNG"), ("spec.docx", b"PK")))
    async with SlackSource(_binding(fake_slack.base)) as s:
        page = await s.fetch(SlackSource.resume_after("200.000200"))
        (item,) = page.items
        png, docx = item.data.attachments
        assert (png.data.name, png.data.media_type, png.data.as_, png.data.size) == ("plan.png", "image/png", FileKind.IMAGE, 4)
        assert docx.data.as_ is FileKind.DOCUMENT and png.origin == s.origin(png.origin.key, "C1")
        assert png.origin.url.startswith("https://example.slack.com/files/"), "the file's permalink, a link for people"
        got = b""
        async with s.open(png) as chunks:
            async for chunk in chunks:
                got += chunk
    assert got == b"\x89PNG" and slack.downloads == ["Bearer xoxb-test"]


async def test_a_traversal_stages_inbound_files_on_this_machine(double):
    delivered = double.deliver("look", sender="U42", files=[("chart.png", b"\x89PNG chart")])
    source = _source(**double.config)
    await source.save()
    result = await DataDriver.loaded("slack").traverse(source, _view())
    (item,) = result.items
    (staged,) = item.data.attachments
    assert staged.origin.key == delivered["files"][0] and staged.data.fetch_error is None
    from pathlib import Path

    assert Path(staged.data.path).read_bytes() == b"\x89PNG chart"


def test_a_file_slack_will_not_serve_keeps_its_metadata_and_says_why():
    s = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL}))
    item = s._item(CHANNEL, _message("1.0", "x", files=[{"id": "F9", "name": "gone.pdf", "mode": "tombstone"}]))
    (f,) = item.data.attachments
    assert f.data.name == "gone.pdf" and f.data.fetch_error == "deleted on Slack"


# ── reactions ────────────────────────────────────────────────────────────────


async def test_a_messages_reactions_are_one_set_per_person(fake_slack):
    fake_slack.slack.arrive("C1", "ship it?", user="U2", reactions={"+1": ["U3", "U4"], "eyes": ["U3"], "partyparrot": ["U4"], "thumbsup::skin-tone-3": ["U5"]})
    async with SlackSource(_binding(fake_slack.base)) as s:
        page = await s.fetch(SlackSource.resume_after("200.000200"))
    message, *reactions = page.items
    assert all(isinstance(r.data, ReactionData) and r.data.mode is ReactionMode.SET for r in reactions)
    assert {r.data.sender.origin.key: r.data.emojis for r in reactions} == {
        "U3": ("👍", "👀"),
        "U4": ("👍", ":partyparrot:"),
        "U5": ("👍\U0001f3fc",),
    }
    assert {r.data.target for r in reactions} == {s.origin(message.origin.key, "C1")}
    assert len({r.origin for r in reactions}) == 3


async def test_a_traversal_hands_reactions_to_the_runtime_not_as_records(double):
    delivered = double.deliver("ship it?", sender="U42")
    double.react(delivered["external_id"], "tada", sender="U43")
    source = _source(**double.config)
    await source.save()
    result = await DataDriver.loaded("slack").traverse(source, _view())
    assert [i.body for i in result.items] == ["ship it?"]
    (reaction,) = result.reactions
    assert (reaction.data.target.key, reaction.data.emojis) == (delivered["external_id"], ("🎉",))


async def test_we_react_by_slack_name_and_already_reacted_is_done(fake_slack):
    async with SlackSource(_binding(fake_slack.base)) as s:
        target = s.origin("100.000100", "C1")
        await s.react(target, "👍")
        await s.react(target, "👍")
        await s.react(target, "❤")  # typed without U+FE0F: the same heart
        await s.react(target, ":partyparrot:")
    added = [args for m, args in fake_slack.slack.calls if m == "reactions.add"]
    assert added[0] == {"channel": "C1", "timestamp": "100.000100", "name": "+1"}
    assert [a["name"] for a in added] == ["+1", "+1", "heart", "partyparrot"]
    assert {r["name"]: r["users"] for r in fake_slack.slack.message("C1", "100.000100")["reactions"]} == {
        "+1": ["UBOT"], "heart": ["UBOT"], "partyparrot": ["UBOT"]
    }


async def test_an_emoji_slack_has_no_name_for_is_refused_before_any_request(fake_slack):
    async with SlackSource(_binding(fake_slack.base)) as s:
        with pytest.raises(Rejected):
            await s.react(s.origin("100.000100", "C1"), "🦄")
        with pytest.raises(Rejected):
            await s.unreact(s.origin("100.000100", "C1"), "🦄")
    assert fake_slack.slack.calls == []


async def test_unreact_takes_back_one_or_all_of_ours_and_leaves_others(fake_slack):
    slack = fake_slack.slack
    slack.message("C1", "100.000100")["reactions"] = [
        {"name": "+1", "users": ["UBOT", "U2"], "count": 2}, {"name": "eyes", "users": ["UBOT"], "count": 1}, {"name": "fire", "users": ["U2"], "count": 1},
    ]
    async with SlackSource(_binding(fake_slack.base)) as s:
        target = s.origin("100.000100", "C1")
        await s.unreact(target, "👀")
        await s.unreact(target, "👀")  # no_reaction: already gone
        assert {r["name"]: r["users"] for r in slack.message("C1", "100.000100")["reactions"]} == {"+1": ["UBOT", "U2"], "fire": ["U2"]}
        await s.unreact(target)
    assert {r["name"]: r["users"] for r in slack.message("C1", "100.000100")["reactions"]} == {"+1": ["U2"], "fire": ["U2"]}
    removed = [args["name"] for m, args in slack.calls if m == "reactions.remove"]
    assert removed == ["eyes", "eyes", "+1"]


async def test_the_runtime_reacts_through_the_driver(double):
    delivered = double.deliver("ship it?", sender="U42")
    source = _source(**double.config)
    await source.save()
    driver = DataDriver.loaded("slack")
    target = SlackSource(SourceBinding(account_key=source.account_key, config=double.config)).origin(delivered["external_id"], double.channel)
    await driver.react(source, target, "✅")
    assert double.reactions(delivered["external_id"]) == {"white_check_mark": ["UBOT"]}
    await driver.react(source, target, "", remove=True)
    assert double.reactions(delivered["external_id"]) == {}


def test_the_emoji_table_round_trips():
    emojis = asset_module("slack", "emojis")
    for name in ("+1", "heart", "white_check_mark", "point_up", "100", "memo"):
        assert emojis.name_of(emojis.unicode_of(name)) == name
    assert emojis.name_of("👍🏽") == "+1::skin-tone-4" and emojis.unicode_of("+1::skin-tone-4") == "👍🏽"
    assert emojis.unicode_of("thumbsup") == "👍" and emojis.name_of("🦄") is None


# ── everything the person is in (no channel: their own app) ──────────────────


def _everything(base: str, **config) -> SourceBinding:
    return SourceBinding(
        account_key="T1",
        config={"base_url": base, "team_id": "T1", "user_id": "UBOT", **config},
        credentials=ResolvedSecrets(shape=AuthShape.SECRETS, choice="app",
                                    values={"SLACK_USER_TOKEN": SecretStr("xoxp-mine")}),
    )


def test_no_channel_is_everything_and_a_channel_row_is_not_its_twin():
    everything = SlackSource(SourceBinding(account_key="T1", config={}))
    one = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL}))
    assert everything.everything and everything.query().conversation is None
    assert not one.everything
    assert SlackSource.account_part({}) == SlackSource.EVERYTHING and SlackSource.account_part({"channel": CHANNEL}) == ""
    assert SlackSource.account_part({"channel": {"id": CHANNEL, "name": "eng"}}) == ""


async def test_an_everything_row_is_never_found_by_a_channel_lookup_and_may_share_the_workspace():
    everything = DataSource(provider="slack", name=f"Slack all {uuid.uuid4().hex[:8]}", account_key="@eran", config={"base_url": BASE})
    mine = _saved_channel()
    one = _source(channel=mine)
    one.account_key = "@eran"
    await everything.save()
    await one.save()
    try:
        found = await DataSource.find_for_account("slack", "channel", mine)
        assert found is not None and found.id == one.id
        whole = await DataSource.find_for_account("slack", "", "@eran", part=SlackSource.EVERYTHING)
        assert whole is not None and whole.id == everything.id
        found_as_account = await DataSource.find_for_account("slack", "", "@eran")
        assert found_as_account is not None and found_as_account.id == one.id, "the default part is the channel row's, as every channel lookup expects"
    finally:
        await everything.delete()
        await one.delete()


def test_the_everything_cursor_round_trips_refuses_garbage_and_stays_under_budget():
    state = slack_source._AllCursor()
    state.swept = 1700000000.0
    state.newest = {"C1": "100.000100", "D1": ""}
    state.pending = {"G1": ["200.000200", "abc"]}
    again = slack_source._AllCursor.decode(state.encode())
    assert (again.swept, again.newest, again.pending) == (1700000000.0, state.newest, state.pending)
    assert slack_source._AllCursor.decode(None).newest == {}
    for bad in ("resume:1.0", "all:[", "all:{}", 'all:{"c": 3}'):
        with pytest.raises(slack_source.InvalidCursor):
            slack_source._AllCursor.decode(bad)
    with pytest.raises(TypeError):
        slack_source._AllCursor.decode(5)
    crowd = slack_source._AllCursor()
    crowd.newest = {f"C{i:09d}": f"{1000 + i}.000000" for i in range(400)}
    crowd.pending = {"C000000399": ["1399.000000", "pg"]}
    text = crowd.encode()
    assert len(text) <= slack_source.CURSOR_BUDGET < 4096
    kept = slack_source._AllCursor.decode(text)
    assert "C000000399" in kept.newest and "C000000398" in kept.newest, "the busiest conversations stay"
    assert "C000000000" not in kept.newest, "the quietest are forgotten first (re-floored at the window next time)"
    rest = sorted(c for c in kept.newest if c != "C000000399")
    assert kept.due(3) == ["C000000399", *rest[:2]], "mid-page first, then the rotation from where it stands"
    assert slack_source._AllCursor.decode(kept.encode()).offset == kept.offset == 2, "the rotation survives the cursor"


def test_a_pass_reads_changed_conversations_first_and_rotates_through_the_rest():
    """A conversation the sweep says moved since it was read is read first; never-read ones next; the rest in
    turn, so every one is reached — a self-DM cannot be starved by a set of busier channels."""
    state = slack_source._AllCursor()
    state.newest = {"C1": "100.0", "C2": "100.0", "C3": "100.0", "D1": "100.0", "N1": ""}
    state.pending = {"P1": ["150.0", "pg"]}
    state.updated = {"D1": 120.0, "N1": 110.0, "C1": 50.0, "C2": 50.0, "C3": 50.0}  # D1 moved since it was read
    assert state.due(3) == ["P1", "D1", "N1"], "mid-page, changed, never read"
    assert state.due(5) == ["P1", "D1", "N1", "C1", "C2"]
    state.updated["D1"] = state.updated["N1"] = 50.0  # both quiet now
    state.newest["N1"] = "100.0"  # N1 read: it joins the rotation
    assert state.due(2) == ["P1", "C3"], "the rotation goes on from where it stood"
    assert state.due(3) == ["P1", "D1", "N1"]
    assert state.due(3) == ["P1", "C1", "C2"], "and wraps around"


async def test_everything_reads_every_conversation_from_the_window_then_only_what_is_new(fake_slack):
    slack = fake_slack.slack
    slack.channels["D1"] = [_message("120.000120", "a dm")]
    slack.channels["G1"] = [_message("130.000130", "a group dm", user="U7")]
    source = SlackSource(_everything(fake_slack.base))
    async with source:
        first = await source.fetch(None, narrow={"since": datetime.fromtimestamp(110, tz=timezone.utc)})
        texts = sorted(i.data.text for i in first.items if isinstance(i, slack_source.MessageItem))
        assert texts == ["a dm", "a group dm", "later"], "every conversation, floored at the window (root at 100 is older; a reply comes live)"
        dm = next(i for i in first.items if i.data.text == "a dm")
        assert dm.origin.namespace == "T1/D1" and dm.data.sender.name == "@dana", "named through users.info"
        unknown = next(i for i in first.items if i.data.text == "a group dm")
        assert unknown.data.sender.name is None, "a member with no profile keeps no name"
        assert first.next_cursor is None and first.resume_cursor.startswith("all:")
        state = slack_source._AllCursor.decode(first.resume_cursor)
        assert state.newest == {"C1": "200.000200", "D1": "120.000120", "G1": "130.000130"} and not state.pending

        second = await source.fetch(first.resume_cursor)
        assert second.items == () and slack_source._AllCursor.decode(second.resume_cursor).newest == state.newest

        slack.arrive("D1", "hello again", user="U1")
        slack.arrive("D2", "a brand new dm", user="U9")  # a conversation that did not exist at the sweep
        third = await source.fetch(second.resume_cursor)
        assert [i.data.text for i in third.items] == ["hello again"], "the new conversation waits for the next sweep"
        stale = slack_source._AllCursor.decode(third.resume_cursor)
        stale.swept = 0
        fourth = await source.fetch(stale.encode())
        assert [i.data.text for i in fourth.items] == ["a brand new dm"]
    assert slack.calls.count(("users.conversations", {"types": slack_source.CONVERSATION_TYPES, "exclude_archived": "true", "limit": "200"})) == 2


async def test_a_busy_conversation_is_paged_across_passes_without_skipping(fake_slack, monkeypatch):
    monkeypatch.setattr(slack_source, "EVERYTHING_PAGE", 2)
    slack = fake_slack.slack
    slack.channels = {"D1": [_message(f"{100 + i}.000000", f"m{i}") for i in range(5)]}
    source = SlackSource(_everything(fake_slack.base))
    seen: list[str] = []
    async with source:
        cursor = None
        for _ in range(4):
            page = await source.fetch(cursor)
            seen.extend(i.data.text for i in page.items if isinstance(i, slack_source.MessageItem))
            cursor = page.resume_cursor
        state = slack_source._AllCursor.decode(cursor)
        assert sorted(seen) == ["m0", "m1", "m2", "m3", "m4"] and not state.pending and state.newest == {"D1": "104.000000"}
        slack.arrive("D1", "m5", user="U1")
        assert [i.data.text for i in (await source.fetch(cursor)).items] == ["m5"]


async def test_a_conversation_the_person_left_is_forgotten_and_a_step_back_in_time_reads_nothing(fake_slack):
    slack = fake_slack.slack
    slack.channels["D1"] = [_message("120.000120", "a dm")]
    source = SlackSource(_everything(fake_slack.base))
    async with source:
        first = await source.fetch(None)
        del slack.channels["D1"]  # left (channel_not_found from now on)
        state = slack_source._AllCursor.decode(first.resume_cursor)
        state.swept = 0
        second = await source.fetch(state.encode())
        assert "D1" not in slack_source._AllCursor.decode(second.resume_cursor).newest
        assert (await source.fetch(None, narrow={"before": datetime.fromtimestamp(150, tz=timezone.utc)})).items == ()


def test_the_credential_way_picks_the_token():
    def source(choice, **values):
        return SlackSource(SourceBinding(account_key="T1", config={}, credentials=ResolvedSecrets(
            shape=AuthShape.SECRETS, choice=choice, token=SecretStr("xoxp-signin") if "signin" in values else None,
            values={k: SecretStr(v) for k, v in values.items() if k != "signin"})))
    both = {"SLACK_BOT_TOKEN": "xoxb-bot", "SLACK_USER_TOKEN": "xoxp-me"}
    assert source("app", **both)._token() == "xoxp-me"
    assert source("bot", **both)._token() == "xoxb-bot"
    assert source("", **both)._token() == "xoxb-bot"
    assert source("", SLACK_USER_TOKEN="xoxp-me")._token() == "xoxp-me"
    assert source("signin", signin=True, **both)._token() == "xoxp-signin"
    assert source("app", signin=True)._token() == "xoxp-signin", "an app way with no token yet falls back to the sign-in"


def test_a_room_is_the_conversations_address_and_a_dm_is_with_its_other_side():
    everything = SlackSource(_everything(""))
    assert SlackSource.room_of(everything._item("C1", _message("1.0", "x"))) == "C1"
    assert SlackSource.room_of(everything._item("G1", _message("1.0", "x"))) == "G1"
    assert SlackSource.room_of(everything._item("D1", _message("1.0", "x"))) == ""


# ── live: the person's app's events land as the poll would have read them ────


def test_an_event_lands_as_the_same_record_the_poll_reads():
    source = SlackSource(_everything(""))
    message = {**_message("200.000200", "hello", thread_ts="100.000100"), "channel": "C1", "channel_type": "channel"}
    polled = source._item("C1", message)
    for payload in (
        {"team_id": "T1", "event": {"type": "message", **message}},
        {"type": "event_callback", "team_id": "T1", "api_app_id": "A1", "event": {"type": "message", **message}},
    ):
        (event,) = source.events_from_webhook(payload)
        assert event.kind is slack_source.EventKind.UPSERT and event.origin == polled.origin and event.item.data.text == "hello"
        assert event.item.data.conversation == polled.data.conversation and event.id == "C1:200.000200"
    assert event.item.data.sender.name is None, "nobody looked U1 up yet"
    slack_source._NAMES[(source.base_url, "T1", "U1")] = "@dana"
    try:
        (named,) = source.events_from_webhook({"team_id": "T1", "event": {"type": "message", **message}})
        assert named.item.data.sender.name == "@dana", "a sender a pass already named is named on a pushed event too"
    finally:
        slack_source._NAMES.pop((source.base_url, "T1", "U1"), None)
    assert source.events_from_webhook({"team_id": "T9", "event": {"type": "message", **message}}) == [], "another workspace"
    assert source.events_from_webhook({"team_id": "T1", "event": {"type": "message", "subtype": "channel_join", "channel": "C1", "ts": "1.0", "user": "U2"}}) == []
    assert source.events_from_webhook({"team_id": "T1", "event": {"type": "pin_added", "channel": "C1"}}) == []
    assert source.events_from_webhook("garbage") == [] and source.events_from_webhook({"team_id": "T1"}) == []


def test_an_edit_a_deletion_a_file_and_reactions_each_do_their_thing():
    source = SlackSource(_everything(""))
    edited = {"type": "message", "subtype": "message_changed", "channel": "C1", "ts": "201.000000", "event_ts": "201.000000",
              "message": _message("200.000200", "hello!", edited={"ts": "201.000000"})}
    (event,) = source.events_from_webhook({"team_id": "T1", "event": edited})
    assert event.kind is slack_source.EventKind.UPSERT and event.origin.key == "200.000200" and event.item.data.text == "hello!"

    (gone,) = source.events_from_webhook({"team_id": "T1", "event": {"type": "message", "subtype": "message_deleted", "channel": "C1", "deleted_ts": "200.000200", "ts": "202.0"}})
    assert gone.kind is slack_source.EventKind.DELETE and gone.origin == source._message_origin("200.000200", "C1") and gone.item is None

    shared = {"type": "message", "subtype": "file_share", "channel": "D1", "user": "U1", "ts": "300.000300", "text": "see",
              "files": [{"id": "F1", "name": "a.png", "mimetype": "image/png", "size": 3}]}
    (with_file,) = source.events_from_webhook({"team_id": "T1", "event": shared})
    assert [f.data.name for f in with_file.item.data.attachments] == ["a.png"] and with_file.item.origin.namespace == "T1/D1"

    liked = {"type": "reaction_added", "user": "U2", "reaction": "thumbsup", "event_ts": "400.0", "item": {"type": "message", "channel": "C1", "ts": "200.000200"}}
    (thumb,) = source.events_from_webhook({"team_id": "T1", "event": liked})
    assert isinstance(thumb.item, slack_source.ReactionItem) and thumb.item.data.mode is ReactionMode.ADD
    assert thumb.item.data.emojis == ("👍",) and thumb.item.data.target == source.origin("200.000200", "C1")
    assert thumb.item.origin == source.origin("200.000200#reaction:U2", "C1"), "the same report key the poll uses"
    (unthumb,) = source.events_from_webhook({"team_id": "T1", "event": {**liked, "type": "reaction_removed", "event_ts": "401.0"}})
    assert unthumb.item.data.mode is ReactionMode.REMOVE and unthumb.id != thumb.id
    assert source.events_from_webhook({"team_id": "T1", "event": {**liked, "item": {"type": "file", "file": "F1"}}}) == []


async def test_a_pushed_event_is_ingested_through_the_runtime_like_a_polled_one(monkeypatch):
    double = asset_module("slack", "tests.matrix").Double(everything=True)
    with double:
        monkeypatch.setattr(DataDriver.loaded("slack"), "credentials_for", double.credentials)
        source = DataSource(provider="slack", name=f"Slack all {uuid.uuid4().hex[:8]}", account_key="@me", config=double.config)
        await source.save()
        try:
            arrived = double.deliver("pushed to you", sender="U42", channel="D7")
            result = await DataDriver.loaded("slack").ingest_pushed(source, double.push(arrived["external_id"], channel="D7"), verified_by_hub=True)
            assert result["ingested"] == 1
            (row,) = await SourceItem.get_all({"data_source_id": str(source.id)})
            assert (row.body, row.author_external_id, row.external_id) == ("pushed to you", "U42", arrived["external_id"])
            again = await DataDriver.loaded("slack").ingest_pushed(source, double.push(arrived["external_id"], channel="D7"), verified_by_hub=True)
            assert again["ingested"] == 1 and len(await SourceItem.get_all({"data_source_id": str(source.id)})) == 1, "a redelivery upserts in place"
        finally:
            await source.delete()


# ── the slack-connect wizard: the claim, the manifest, the app ───────────────


def test_the_hub_claim_is_pending_until_the_app_is_known_then_proven_with_it():
    secrets = {"SLACK_USER_TOKEN": "xoxp-me"}
    assert SlackSource.hub_claim({}, {}) == {"provider": "slack", "key": ""}, "the URL first"
    assert SlackSource.hub_claim({"team_id": "T1"}, {"SLACK_USER_TOKEN": "xoxp-me"}) == {"provider": "slack", "key": "T1", "proof": {"credential": "xoxp-me"}}, (
        "the token proves the workspace"
    )
    assert SlackSource.hub_claim({"team_id": "T1"}, secrets) == {"provider": "slack", "key": "T1", "proof": {"credential": "xoxp-me"}}
    assert SlackSource.hub_claim({"channel": CHANNEL, "team_id": "T1"}, secrets) is None, "one channel as a bot is polled"


def test_the_manifest_link_creates_the_app_with_its_request_url_scopes_and_events():
    from urllib.parse import parse_qs, urlparse

    link = slack_source.manifest_link("https://hub.example/api/v1/webhook/abc")
    parsed = urlparse(link)
    assert parsed.netloc == "api.slack.com" and parsed.path == "/apps"
    query = parse_qs(parsed.query)
    assert query["new_app"] == ["1"]
    manifest = json.loads(query["manifest_json"][0])
    assert manifest["settings"]["event_subscriptions"]["request_url"] == "https://hub.example/api/v1/webhook/abc"
    assert set(manifest["settings"]["event_subscriptions"]["user_events"]) == set(slack_source.USER_EVENTS)
    assert set(manifest["oauth_config"]["scopes"]["user"]) == set(slack_source.USER_SCOPES) and "bot" not in manifest["oauth_config"]["scopes"]
    assert manifest["settings"]["socket_mode_enabled"] is False and len(link) < 2000


def test_the_app_is_named_after_the_signed_in_person(monkeypatch):
    from flow_sdk.cloud_client import auth_state

    for user, expected in (
        ({"display_name": "Eran Shlomo", "email": "eran@langware.ai"}, "Eran's inbox"),
        ({"first_name": "dana"}, "Dana's inbox"),
        ({"name": "myslack-7", "email": "myslack-7@local.test"}, "Myslack-7's inbox"),
        ({"email": "bob@example.com"}, "Bob's inbox"),
        ({}, "Flowpad inbox"),
    ):
        monkeypatch.setattr(auth_state, "login_block", lambda user=user: {"status": "logged_in", "user": user})
        assert slack_source.app_name() == expected, user
    link = slack_source.manifest_link("https://hub.example/api/v1/webhook/abc", "Eran's inbox")
    assert "Eran%27s%20inbox" in link


async def test_the_manifest_step_waits_for_the_url_and_a_channel_row_has_no_app():
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    waiting = SlackSource(SourceBinding(account_key="T1", config={}, credentials=ResolvedSecrets()))
    assert (await waiting._manifest_step(check=False, values={})).exit_code is ExitCode.NOT_YET
    held = SlackSource(SourceBinding(account_key="T1", config={}, credentials=ResolvedSecrets(
        shape=AuthShape.SECRETS, values={"webhook_url": SecretStr("https://hub.example/api/v1/webhook/abc")})))
    shown = await held._manifest_step(check=False, values={})
    assert shown.ok and shown.value.shown.link.startswith("https://api.slack.com/apps?new_app=1&manifest_json=")
    one = SlackSource(SourceBinding(account_key="T1", config={"channel": CHANNEL}))
    assert (await one._manifest_step(check=False, values={})).exit_code is ExitCode.NOT_APPLICABLE
    assert (await one._app_step(check=False, values={})).exit_code is ExitCode.NOT_APPLICABLE


async def test_the_app_step_asks_slack_who_the_token_is_and_keeps_it(fake_slack):
    source = SlackSource(SourceBinding(account_key="", config={"base_url": fake_slack.base}, credentials=ResolvedSecrets()))
    missing = await source._app_step(check=False, values={})
    bot = await source._app_step(check=False, values={"user_token": "xoxb-a-bot"})
    kept = await source._app_step(check=False, values={"user_token": "xoxp-mine"})
    assert not missing.ok and "User OAuth Token" in missing.detail
    assert not bot.ok and "xoxp-" in bot.detail
    assert kept.ok and kept.detail == "Connected as @flowpad in T1"
    update = kept.value
    assert update.secrets == {"SLACK_USER_TOKEN": "xoxp-mine"}, "the token, nothing else, in this phase"
    assert update.config == {"team_id": "T1", "user_id": "UBOT"}
    assert update.allowed_senders == ["UBOT"] and update.shown.connected and update.shown.name == "@flowpad"
    assert fake_slack.slack.calls[-1][0] == "auth.test"
    held = SlackSource(SourceBinding(account_key="T1", config={"base_url": fake_slack.base, "team_id": "T1"}, credentials=ResolvedSecrets(
        shape=AuthShape.SECRETS, values={"SLACK_USER_TOKEN": SecretStr("xoxp-mine")})))
    checked = await held._app_step(check=True, values={})
    assert checked.ok and not checked.ran


async def test_a_probe_judges_the_typed_token_and_keeps_nothing(fake_slack):
    """The question's Verify button: ``probe`` judges the typed token by Slack (``auth.test``), names the
    verdict, keeps nothing — and a refused token is refused in words."""
    source = SlackSource(SourceBinding(account_key="", config={"base_url": fake_slack.base}, credentials=ResolvedSecrets()))
    probe = await source._app_step(check=True, values={"user_token": "xoxp-mine"}, probe=True)
    assert probe.ok and not probe.ran and probe.detail == "Connected as @flowpad in T1" and probe.value is None
    fake_slack.slack.refuse = "invalid_auth"
    bad = await source._app_step(check=True, values={"value": "xoxp-stale"}, probe=True)
    assert not bad.ok and "invalid_auth" in bad.detail


async def test_a_check_ignores_a_typed_token_so_the_wizard_still_runs_the_step(fake_slack):
    """The wizard's completion check runs with the run's env — the typed token included. A check judges only
    what is KEPT: with nothing kept it is not satisfied, so the step runs and keeps the token."""
    source = SlackSource(SourceBinding(account_key="", config={"base_url": fake_slack.base}, credentials=ResolvedSecrets()))
    before = await source._app_step(check=True, values={"user_token": "xoxp-mine"})
    assert not before.ok, "typed is not kept"
    kept = await source._app_step(check=False, values={"user_token": "xoxp-mine"})
    assert kept.ok and kept.value.secrets == {"SLACK_USER_TOKEN": "xoxp-mine"}


async def test_the_card_names_a_new_source_the_way_the_app_is_named(monkeypatch):
    from flow_sdk.cloud_client import auth_state

    monkeypatch.setattr(auth_state, "login_block", lambda: {"status": "logged_in", "user": {"first_name": "Eran"}})
    profile = await SlackSource.profile()
    assert profile == {"available": True, "default_name": "Eran's inbox"}
    assert profile["default_name"] == slack_source.app_name(), "one name, defined once"


def test_the_connect_wizard_is_declared_and_every_step_it_names_exists():
    import pathlib

    folder = pathlib.Path(slack_source.__file__).parent / "agentic-assets"
    spec = json.loads((pathlib.Path(slack_source.__file__).parent / "data_driver.json").read_text())
    assert spec["setup_wizards"] == [{"stage": "connect", "label": "Connect", "wizard": "slack-connect", "provides": ["credential"]}], (
        "the wizard writes the credential: the setup tree must not ask for it before the wizard"
    )
    assert spec["webhook"]["url_var"] == "webhook_url" and spec["auth"]["vars"]["webhook_url"] == "SLACK_WEBHOOK_URL"
    assert "SLACK_USER_TOKEN" in spec["auth"]["vars"] and "SLACK_SIGNING_SECRET" not in spec["auth"]["vars"], "the token alone, in this phase"
    wizard = json.loads((folder / "wizard" / "slack-connect" / "wizard.json").read_text())
    ops = {}
    for step in wizard["steps"]:
        op_file = folder / "compute_op" / step["ref"] / "compute_op.json"
        assert op_file.exists(), step["ref"]
        ops[step["id"]] = json.loads(op_file.read_text())
    assert [s["id"] for s in wizard["steps"]] == ["public-url", "manifest", "ask-create-app", "ask-user-token", "app", "prove", "verify"]
    asks = [i for i, op in ops.items() if op["subkind"] == "ask"]
    assert asks == ["ask-create-app", "ask-user-token"], "two things the person does; the first message is proven by the poll"
    # Two sub-steps the person walks: set up on Slack (a Continue, nothing typed), then the token, verified in place.
    assert ops["ask-create-app"]["output_spec_kind"] == "confirm" and ops["ask-create-app"]["exe_data"]["submit_label"] == "Continue"
    assert ops["ask-create-app"]["exe_data"]["stage"] == {"label": "Set up on Slack", "index": 1, "total": 2}
    assert "{{manifest.link}}" in ops["ask-create-app"]["exe_data"]["detail"], "the link the person taps, shown at its place in the run"
    keys = ops["ask-user-token"]
    assert keys["output_spec_kind"] == "string" and keys["exe_data"]["secret"], "one value, masked"
    assert keys["exe_data"]["stage"] == {"label": "Your token", "index": 2, "total": 2}
    assert keys["exe_data"]["verify"] == {"label": "Verify", "source_step": "app"}, "the token is checked in place, by the app step as a probe"
    assert "{{manifest.name}}" in keys["exe_data"]["detail"], "names the app the person just made: asked after it exists"
    assert next(s for s in wizard["steps"] if s["id"] == "ask-user-token")["bind"] == "user_token", "what the app step reads"
    assert ops["public-url"]["exe_data"]["source_step"] == "public-webhook" and ops["prove"]["exe_data"]["source_step"] == "public-webhook"
    for bound in ("public-url", "manifest"):
        assert ops[bound]["output_spec_kind"] == "source.setup_shown", "what the step shows is its value: bound for the next question"
        assert "--value" in ops[bound]["exe_data"]["commands"]["darwin"]
        assert "--check --value" in ops[bound]["completion_check"]["commands"]["darwin"], (
            "a step whose check already holds is skipped: what the check prints is what the next question shows"
        )
    credential = json.loads((folder / "credential" / "slack_channel" / "credential.json").read_text())
    assert credential["vars"]["SLACK_USER_TOKEN"]["way"] == "app" and "SLACK_SIGNING_SECRET" not in credential["vars"]
    assert credential["vars"]["SLACK_WEBHOOK_URL"]["secret"] is False and "app" in credential["ways"]


# ── which agentic process answers: polled and pushed agree ──────────────────
#
# One user, one channel, the two ways the driver receives it: polling (a channel read as a bot, ``fetch``) and the
# webhook (the person's own app; the hub hands each event to ``events_from_webhook``). Every case runs on both.
# Real: the driver, ``envelope_of``, the projection's ``resolve_thread`` and ``TurnEngine.process_for``. In memory:
# ``_FakeSlack`` called in process on a clock the test moves, the thread and process rows, and ``create_process``
# (recorded, never run). CPU only: no hub, no socket, no database.

PERSON = "U0USER001"
AGENT = TypeId(type=EntityType.AGENT.value, id="370da5cb-3c78-4c6e-8c64-22e6642ce74e")
#: The ``Slack bot`` row as routing reads it: its channel, its owner (the agent), its id.
ROW = SimpleNamespace(id="a971983b-2cc5-42c3-a70d-b435cffe29b2", channel="slack", provider="slack", owner=AGENT)
DEPLOYMENT_ID = "580bea72-a5c6-412a-a02e-73dd1e7fc915"


class _InProcess:
    """``_FakeSlack`` as the driver's ``_api``, with no socket; every ``ts`` comes from a clock only the test moves."""

    def __init__(self):
        self.slack, self.now, self.pushed = _FakeSlack(), 1_800_000_000.0, 0
        self.slack.channels = {"C1": []}
        self.slack.fresh_ts = self.tick

    def tick(self, seconds: float = 1.0) -> str:
        self.now += seconds
        return f"{self.now:.6f}"

    def post(self, text: str, *, thread_ts: str | None = None) -> dict:
        return self.slack.arrive("C1", text, user=PERSON, thread_ts=thread_ts)

    async def api(self, method: str, payload: dict, *, verb: str = "GET", token: str = "") -> dict:
        if verb == "POST":
            _, body, _ = self.slack(f"/{method}", {"_body": json.dumps(payload)})
        else:
            _, body, _ = self.slack(f"/{method}?{urlencode(payload)}", {})
        return json.loads(body)

    def events(self) -> list[dict]:
        """Every message written since the last call, as Slack pushes it."""
        written, self.pushed = self.slack.channels["C1"][self.pushed:], len(self.slack.channels["C1"])
        return [{"team_id": "T1", "event": {**m, "channel": "C1", "channel_type": "channel"}} for m in written]


class _Polling:
    """A channel read as a bot: one ``fetch`` per poll, from the cursor the last poll left."""

    def __init__(self, slack: _InProcess):
        self.slack, self.cursor, self.seen = slack, None, set()
        self.source = SlackSource(_binding(""))

    async def arrivals(self) -> list:
        """What the next poll lands that was not landed before (ingest keeps one row per message)."""
        self.slack.tick(300.0)
        page = await self.source.fetch(self.cursor)
        self.cursor = page.resume_cursor or self.cursor
        new = [i for i in page.items if isinstance(i, MessageItem) and i.origin.key not in self.seen]
        self.seen.update(i.origin.key for i in new)
        return new


class _Webhook:
    """The person's own app: each Slack event, as the hub hands it over."""

    def __init__(self, slack: _InProcess):
        self.slack, self.source = slack, SlackSource(_everything("", user_id=PERSON))

    async def arrivals(self) -> list:
        return [e.item for payload in self.slack.events() for e in self.source.events_from_webhook(payload) if isinstance(e.item, MessageItem)]


class _Rows:
    """The thread and process rows the real code reads and writes, and every ``create_process`` call."""

    def __init__(self):
        self.threads: dict[tuple, MessageThread] = {}
        self.processes: list[SimpleNamespace] = []
        self.created: list[dict] = []
        self._ids = itertools.count(1)

    async def find_existing(self, channel, thread_key, owner, data_source_id):
        return self.threads.get((channel, thread_key, str(owner), data_source_id))

    async def save(self, thread):
        self.threads[(thread.channel, thread.thread_key, str(thread.owner), thread.data_source_id)] = thread

    async def local_rows(self, query: dict) -> list:
        match = query.get("match") or {}
        return [p for p in reversed(self.processes) if all(getattr(p, k) == v for k, v in match.items())]  # newest first

    async def create_process(self, prompt: str, **kwargs):
        """Recorded, never run: a row with the fields ``find_process`` reads."""
        self.created.append(kwargs)
        process = SimpleNamespace(
            id=f"ap-{next(self._ids)}", status="stopped", deployment_id=DEPLOYMENT_ID, shell_id=None, cli_config={},
            target_typeid_str=kwargs["target_typeid_str"], workdir=kwargs["workdir"], visible=kwargs["visible"], pty_mode=kwargs["pty_mode"],
            save=_nothing,
        )
        self.processes.append(process)
        return process


async def _nothing(*_args, **_kwargs):
    return None


@pytest.fixture
def rows(monkeypatch) -> _Rows:
    rows = _Rows()

    @asynccontextmanager
    async def transaction():
        yield

    monkeypatch.setattr(MessageThread, "find_existing", rows.find_existing)
    monkeypatch.setattr(MessageThread, "find_unclaimed", _nothing)
    monkeypatch.setattr(MessageThread, "save", lambda thread, *_args, **_kwargs: rows.save(thread))  # called on the thread
    monkeypatch.setattr("flow_sdk.db.get_db_driver", lambda: SimpleNamespace(write_transaction=transaction))
    monkeypatch.setattr(AgenticProcess, "local_rows", rows.local_rows)
    return rows


class _Flowpad:
    """A message from the driver to the AP that answers it: placed in its thread the way the projection
    places it, its session named the way ``answer_one`` names it, its AP picked by ``process_for``."""

    def __init__(self, slack: _InProcess, receiver, rows: _Rows):
        from flow_sdk.builtin.agent_serve import TurnEngine

        agent = type("Agent", (), {"id": AGENT.id, "name": "qa-cycle-manager", "model": None, "get_by_id": staticmethod(_nothing)})()
        deployment = SimpleNamespace(id=DEPLOYMENT_ID, overrides_for=lambda _agent: {}, create_process=rows.create_process)
        self.slack, self.receiver, self.engine = slack, receiver, TurnEngine(agent, deployment, workdir="/agent")

    async def place(self, item: MessageItem) -> str:
        """The conversation ``item`` lands in (``project_source_item``'s thread step)."""
        spec = envelope_of(item, data_source_id=ROW.id, provider="slack")
        thread = await resolve_thread(
            channel_of(ROW), thread_key_for(spec, spec.name or ""), await owner_of(ROW),
            data_source_id=ROW.id, title=spec.body or "", conversation_id=str(spec.conversation_id or ""),
        )
        return thread.conversation_id

    async def answer(self, item: MessageItem):
        """The AP that answers ``item``."""
        session = str(TypeId(type=EntityType.CONVERSATION.value, id=await self.place(item)))
        return await self.engine.process_for(session, name="qa-cycle-manager · slack")

    async def arrivals(self) -> list:
        """What the person wrote that reached Flowpad since the last look."""
        return [i for i in await self.receiver.arrivals() if i.data.sender is not None and i.data.sender.origin.key == PERSON]

    async def top_level(self, text: str):
        """The person writes ``text`` at the top of the channel: the message as it lands, and its AP."""
        self.slack.post(text)
        (message,) = await self.arrivals()
        return message, await self.answer(message)

    async def agent_posts_top_level(self, process, text: str) -> MessageItem:
        """``process`` writes a new top-level message from its own conversation; its sent copy is placed."""
        source = self.receiver.source
        data, answered = source.message_for(thread_key="", to="C1", text=text, conversation_id=TypeId(process.target_typeid_str).id)
        assert answered is None
        sent = await source.send(data)
        await self.place(sent)
        return sent


@pytest.fixture(params=[_Polling, _Webhook], ids=["polling", "webhook"])
async def flowpad(request, rows):
    slack = _InProcess()
    receiver = request.param(slack)
    receiver.source._api = slack.api
    async with receiver.source:
        app = _Flowpad(slack, receiver, rows)
        assert await app.arrivals() == [], "an empty channel landed something"
        yield app


async def test_a_top_level_message_gets_a_fresh_ap(flowpad, rows):
    message, ap = await flowpad.top_level("is the tester alive?")

    (call,) = rows.created
    assert call["target_typeid_str"] == ap.target_typeid_str and ap is rows.processes[0]
    assert message.data.conversation.key == message.origin.key, "a top-level message roots its own thread"


async def test_a_reply_in_the_thread_reuses_the_messages_ap(flowpad, rows):
    message, ap = await flowpad.top_level("cpu and ram?")

    flowpad.slack.post("spin up more testers", thread_ts=message.origin.key)
    replies = await flowpad.arrivals()

    assert [r.data.text for r in replies] == ["spin up more testers"], "the thread reply never reached Flowpad"
    assert await flowpad.answer(replies[0]) is ap, "the reply got another AP"
    assert len(rows.created) == 1, "a fresh AP was asked for the reply"


@pytest.mark.xfail(strict=True, reason="Slack's message_for drops the sending conversation, so the agent's own message opens a new one")
async def test_a_reply_to_the_agents_top_level_message_reuses_the_ap_that_wrote_it(flowpad, rows):
    _, ap = await flowpad.top_level("give status")
    status = await flowpad.agent_posts_top_level(ap, "QA flowpad: iteration i08 is running")

    flowpad.slack.post("why is p12 red?", thread_ts=status.origin.key)
    replies = await flowpad.arrivals()

    assert [r.data.text for r in replies] == ["why is p12 red?"], "the thread reply never reached Flowpad"
    assert await flowpad.answer(replies[0]) is ap, "the reply to the agent's message got another AP than the one that wrote it"
    assert len(rows.created) == 1, "a fresh AP was asked for the reply to the agent's message"
