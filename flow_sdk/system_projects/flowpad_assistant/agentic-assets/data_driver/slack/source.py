"""``SlackSource`` — a Slack workspace, read one of two ways.

**Everything you are in** (no ``channel`` configured): every DM, group DM and channel the signed-in
person is a member of, through their OWN Slack app — an internal app of their workspace acting as them
(a user token). New messages arrive LIVE: the app's Request URL is a hub account claim
(``hub_claim``), the hub checks the app's signature and hands each event to this row
(``events_from_webhook``); polling only fills in history on connect and catches up after the box was
offline. The person's own posts are read like anyone's — the runtime knows them as the account's user
(``sent_by_us``). The ``slack-connect`` wizard (``agentic-assets/wizard``) sets it up: the URL first, then
a link that creates the app from a manifest naming that URL, two pasted secrets, a proof.

**One channel as a bot** (``channel`` configured): a channel the bot has been let into, read one page
per pass. **The rate cap shapes that mode.** Since 2025-05-29 Slack allows an app distributed outside
the Marketplace one ``conversations.history`` request a minute, at most 15 messages, so a pass reads one
page of the channel (``pages_per_pass = 1``): a busy channel is sampled, not mirrored. An internal app
(the person's own, above) is exempt — Slack's changelog: "internal customer-built applications are not
impacted" — so everything-mode reads ``EVERYTHING_PAGE`` a call, ``CHANNELS_PER_PASS`` conversations a pass.

**Setup is a state, not a failure.** Slack will not let an app read a channel the bot was never
invited to, and a private channel needs a human to do the inviting. ``verify`` asks the channel
the cheapest question with the right answer (``conversations.history``, ``limit=1``) and names
it while it is still waiting on an invite.

**200 is not success.** Slack answers ``{"ok": false, "error": …}`` with status 200, so every
call goes through one translation into the contract's errors.

Origins: a channel is ``(slack, <account>/<channel>, <channel>)``; a message and a thread root
are ``(slack, <account>/<channel>, <ts>)``. A message's ``conversation`` is its thread root — a
top-level message is its own — and ``in_reply_to`` is never guessed from the thread. A file on a
message is ``(slack, <account>/<channel>, <file id>)``; a reaction report is keyed
``<ts>#reaction:<user>``.

**Files** go up in Slack's three steps (``files.getUploadURLExternal`` → the bytes to the URL it
hands out → ``files.completeUploadExternal``), all of a send's files and its text (as
``initial_comment``) in ONE message. Slack answers that last step with no message ``ts``, so the
send reports ``file:<first file id>`` and records nothing: the provider's echo, read on the next
pass, is the record. An upload carries no persona (``username``/``icon_emoji`` are
``chat.postMessage``'s alone). Inbound files are read through ``files.info`` → ``url_private_download``
with the bot token.

**Reactions** are read off ``conversations.history``: each message's ``reactions`` is reported as one
SET per person — everything they hold on it. Polling only sees a message while it is in the page a
pass reads, so a reaction added later, and a reaction taken back, are seen only live: Slack's
``reaction_added``/``reaction_removed`` events (ADD/REMOVE), which everything-mode receives.
"""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional, Union
from urllib.parse import quote

from pydantic import StringConstraints

from flow_sdk.builtin.source_item import ChannelMessageSpec
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.sources import http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import ChoiceEntry, Sharing, SourceConfig, config_field
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.files import FileSupport, check_files, kind_of, read_file
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.setup_steps import SetupShown, SourceUpdateSpec, setup_step
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import (
    FileItem,
    FileKind,
    MessageData,
    MessageFileData,
    MessageItem,
    ReactionData,
    ReactionItem,
    ReactionMode,
    UserProfile,
)
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import MessageQuery

from .emojis import name_of, unicode_of

#: Slack's own base — the default when a row's ``base_url`` is empty.
SLACK_API_BASE = "https://slack.com/api"
#: Slack's ceiling per ``conversations.history`` call for an app distributed outside the Marketplace
#: (one call a minute) — the bot mode's page.
HISTORY_PAGE = 15
#: What a person's own internal app reads a call (Slack's hard ceiling is 999; 100 keeps a pass short).
EVERYTHING_PAGE = 100
#: Conversations one everything-mode pass reads (in the order ``_AllCursor.due`` gives): a first connect
#: lands the live ones within a pass or two, a quiet workspace is swept in one.
CHANNELS_PER_PASS = 20
#: How often everything-mode re-lists the person's conversations (a new DM, a joined channel).
SWEEP_SECONDS = 60  # every poll at the default cadence: the sweep is what says which conversations moved
#: Every conversation kind a person can be in.
CONVERSATION_TYPES = "public_channel,private_channel,im,mpim"
#: The everything cursor stays under ``MAX_CURSOR_LENGTH`` (4096): past this, the conversations whose
#: newest message is oldest are forgotten and re-floored at the window on their next read.
CURSOR_BUDGET = 3072
#: Senders named per pass (``users.info``): the rest are named on a later pass.
NAMES_PER_PASS = 20

#: What the person's own app asks for, as them (``oauth_config.scopes.user`` of its manifest): read every
#: conversation kind, name people, write, files and reactions both ways.
USER_SCOPES = (
    "channels:history", "groups:history", "im:history", "mpim:history",
    "channels:read", "groups:read", "im:read", "mpim:read", "users:read",
    "chat:write", "files:read", "files:write", "reactions:read", "reactions:write",
)
#: The events it subscribes to, as them (``settings.event_subscriptions.user_events``).
USER_EVENTS = ("message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "reaction_removed")
#: What the person's own app is called in their workspace when nobody is signed in to name it after.
DEFAULT_APP_NAME = "Flowpad inbox"
#: Slack's ceiling for an app's display name.
APP_NAME_MAX = 35


def app_name() -> str:
    """``"<first name>'s inbox"`` — the app is the person's, named so their workspace can tell whose it is
    (``login_block``: the signed-in person; their display name, else first name, else account name, else the
    email's local part); ``DEFAULT_APP_NAME`` when nobody is signed in."""
    try:
        from flow_sdk.cloud_client.auth_state import login_block  # noqa: PLC0415

        user = (login_block() or {}).get("user") or {}
    except Exception:  # noqa: BLE001 — a name is a nicety; setup never fails over it
        user = {}
    who = str(user.get("display_name") or user.get("first_name") or user.get("name") or "").strip()
    if not who and user.get("email"):
        who = str(user["email"]).split("@", 1)[0]
    who = who.split()[0] if who else ""
    return (f"{who[:1].upper()}{who[1:]}'s inbox" if who else DEFAULT_APP_NAME)[:APP_NAME_MAX].rstrip()

NOT_A_MEMBER = frozenset({"not_in_channel"})
NO_SUCH_CHANNEL = frozenset({"channel_not_found"})
REFUSED_CREDENTIAL = frozenset({"invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope"})
#: "Wait", not "you are misconfigured": the next pass is the retry.
TRANSIENT = frozenset({"ratelimited", "rate_limited", "service_unavailable", "internal_error", "fatal_error"})
#: Channel bookkeeping rather than something someone said.
NOT_A_MESSAGE = frozenset(
    {"channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "channel_archive", "channel_unarchive"}
)

#: A reaction we asked for that is already there, or a take-back of one that is not: done either way.
ALREADY = frozenset({"already_reacted", "no_reaction"})
#: A file Slack lists but will not serve.
UNSERVED = {"tombstone": "deleted on Slack", "hidden_by_limit": "hidden by the workspace's plan limit"}
#: Bytes one read of a file yields at most.
CHUNK = 65536

_RESUME = "resume:"
_PAGE = "page:"
_ALL = "all:"

#: Names of the people a workspace's messages come from, across passes (a source is opened per pass):
#: ``(base url, team, user id) -> "@handle"``. Bounded; the oldest entries go.
_NAMES: dict[tuple[str, str, str], str] = {}
_NAMES_CAP = 2000


class SlackMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.slack"
    digest_exclude: ClassVar[frozenset[str]] = frozenset({"raw", "recorded"})

    raw: Optional[dict] = None
    #: A sent message whose record is the provider's echo, not a copy made at send (an upload: Slack
    #: names no message ``ts`` for it, so a copy would be a second row once the echo lands).
    recorded: bool = False


class SlackConfig(SourceConfig):
    """What a slack source is configured with. No ``channel`` is EVERYTHING the signed-in person is in
    (their own app, a user token); a channel is one channel read as a bot."""

    retired_list = ("channels", "channel")

    channel: Optional[Union[Annotated[str, StringConstraints(pattern=r"^[CGD][A-Z0-9]{6,}$")], ChoiceEntry]] = None
    #: Who may drive the channel; the row keeps it as ``allowed_senders``.
    allowed_senders: list[str] = []
    #: Empty is Slack itself; a test points a row at a local double. Never a secret.
    base_url: str = ""
    #: Learned by the ``app`` setup step from ``auth.test``: the workspace the person's app acts in, and who
    #: they are there. Not secrets; the hub claim is keyed by the team.
    team_id: str = ""
    user_id: str = config_field("", sharing=Sharing.PRIVATE)


class SlackSource(MessageSource):

    Config = SlackConfig
    provider = "slack"
    durable_cursor = True
    #: ``narrow={"before": t}`` reads one page of history older than ``t`` (``latest``), newest first.
    pages_backward = True
    page_size = HISTORY_PAGE
    pages_per_pass = 1
    #: A Slack source is ABOUT its channel: a caller reuses the row that names it. An everything row
    #: names none: it is the account itself (``account_part``).
    identity_config_key = "channel"
    # Signed in as a person, the account is shared: what that person types is answered, only the
    # agent's own replies (``sent_by_us``) are not. See ``agent_serve.answer``.
    answers_its_account = True
    #: While someone waits on the channel (an agent serving it, a viewer), poll it this often. Slack's
    #: ``conversations.history`` allows ~50 calls a minute; 5s is 12.
    attention_poll_seconds = 5
    connection = "slack"
    #: Every kind goes up as a plain file; up to ten, and the text, in one message. No per-file caption.
    files = FileSupport(kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.AUDIO, FileKind.DOCUMENT}), per_message=10)
    #: A reply threads; it never quotes the message it answers.
    quotes = False
    #: A person keeps any number of reactions on a message.
    reactions_per_actor = 0

    @classmethod
    async def profile(cls) -> dict:
        """This way of connecting, for the Add form's card: available, and what a new source should be called —
        the one name (``app_name``) the person's Slack app gets too."""
        return {"available": True, "default_name": app_name()}

    @classmethod
    async def recent(cls, hours: float = 24.0) -> dict[str, Any]:
        """What happened lately in the channels this machine's Slack account is in (``recent.py``)."""
        from .recent import recent  # noqa: PLC0415

        return await recent(hours)

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_after(cls, ts: str) -> str:
        """The resume cursor that continues after message ``ts``."""
        return _RESUME + ts

    #: ``account_part`` of an everything row: not a channel row's twin, and never found by a channel lookup.
    EVERYTHING = "everything"

    @classmethod
    def account_part(cls, config: Mapping[str, Any]) -> str:
        """A channel row is looked up by its channel (``identity_config_key``, the default part); an everything
        row is a part of its own — so one person may hold both on one workspace without either being the
        other's twin, and a connect-or-reuse by channel never lands on the everything row."""
        return "" if _channel_key(config) else cls.EVERYTHING

    @classmethod
    def room_of(cls, item: Any) -> str:
        """A channel or group DM is a room: the conversation continues there, never at whoever wrote.
        A DM (``D…``) is with its other side."""
        namespace = getattr(item, "origin_namespace", "") or getattr(getattr(item, "origin", None), "namespace", "")
        channel = str(namespace or "").rsplit("/", 1)[-1]
        return "" if not channel or channel.startswith("D") else channel

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or SLACK_API_BASE).rstrip("/")

    @property
    def channel(self) -> tuple[str, str]:
        """``(id, label)`` of the configured channel, keyed by id — a renamed channel is the same one.
        The entry is a bare id or ``{"id", "name"}``; ``("", "")`` when none is configured."""
        entry, key = self.config.get("channel") or "", _channel_key(self.config)
        return (key, (str(entry.get("name") or key) if isinstance(entry, dict) else key)) if key else ("", "")

    @property
    def everything(self) -> bool:
        """No channel configured: every conversation the person is in."""
        return not self.channel[0]

    def query(self) -> MessageQuery:
        key = self.channel[0]
        return MessageQuery(conversation=self.channel_origin(key) if key else None)

    def channel_origin(self, channel: str) -> CloudOrigin:
        return self.origin(channel, channel)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        return ChannelMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """The application's send arguments as a Slack message: ``to`` is the channel (a Slack thread
        key is a bare ``ts`` and names none), and the thread it lands in is ``thread_key``. A subject
        has no Slack equivalent. Text may be empty here — a files-only send; ``send`` refuses a
        message with neither."""
        channel = str(to or "").strip()
        if not channel:
            raise ValueError("a slack send needs the channel id in `to`")
        thread = str(thread_key or "").strip() or str(in_reply_to or "").strip()
        return MessageData(text=text, conversation=self.origin(thread, channel) if thread else self.channel_origin(channel)), None

    # ── session ─────────────────────────────────────────────────────────────
    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> ChangePage:
        self._require_open()
        query = self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        conversation = query.conversation
        if conversation is None:
            if self.everything:
                return await self._fetch_all(cursor, query)
            if cursor is not None:
                raise InvalidCursor("this source has no channel to continue")
            return ChangePage(items=())
        channel, thread = self._where(conversation)
        if thread is not None:
            raise Unsupported("reading a single Slack thread is not supported")

        params: dict[str, Any] = {"channel": channel, "limit": min(limit, HISTORY_PAGE), "inclusive": "false"}
        if query.before is not None:
            return await self._older(channel, query.before, params)
        oldest, newest = _start(query, cursor)
        if isinstance(cursor, str) and cursor.startswith(_PAGE):
            params["cursor"] = _page_state(cursor)["cursor"]
        if oldest:
            params["oldest"] = oldest

        body = await self._call("conversations.history", **params)
        messages = [m for m in body.get("messages") or [] if m.get("ts")]
        seen = [str(m["ts"]) for m in messages] + [ts for ts in (newest, oldest) if ts]
        newest = max(seen, key=_ts_key) if seen else None
        more = str((body.get("response_metadata") or {}).get("next_cursor") or "")
        items: list = []
        for m in messages:
            if m.get("subtype") not in NOT_A_MESSAGE:
                items.append(self._item(channel, m))
                items.extend(self._reactions(channel, m))
        return ChangePage(
            items=tuple(items),
            next_cursor=_PAGE + json.dumps({"cursor": more, "oldest": oldest, "newest": newest}) if more else None,
            resume_cursor=_RESUME + newest if newest else None,
        )

    # ── everything the person is in ─────────────────────────────────────────
    async def _fetch_all(self, cursor: Optional[str], query: MessageQuery) -> ChangePage:
        """One pass over every conversation the person is in: the list (re-swept at most every
        ``SWEEP_SECONDS``), then up to ``CHANNELS_PER_PASS`` of them — ones mid-page, then ones the sweep says
        changed since they were read, then never read, then the rest in turn (``_AllCursor.due``) — each from
        its own high-water mark (or the window floor). A conversation with more new messages than one page
        keeps Slack's page cursor and its pending high-water mark until the pages run out, so nothing in
        between is skipped. A step back in time (``before``) names no conversation here: nothing to read."""
        if query.before is not None:
            return ChangePage(items=())
        state = _AllCursor.decode(cursor)
        now = time.time()
        if not state.newest or now - state.swept > SWEEP_SECONDS:
            listed = await self._conversations()
            for conversation in listed:
                state.newest.setdefault(conversation["id"], "")
            state.swept = now
            # Slack's ``updated`` is milliseconds; most recently active first.
            updated = {c["id"]: float(c.get("updated") or 0) / 1000.0 for c in listed}
            state.updated = dict(sorted(updated.items(), key=lambda kv: -kv[1]))
        floor = f"{query.since.timestamp():.6f}" if query.since else ""
        items: list = []
        for channel in state.due(CHANNELS_PER_PASS):
            pending = state.pending.get(channel)
            params: dict[str, Any] = {"channel": channel, "limit": EVERYTHING_PAGE, "inclusive": "false"}
            oldest = state.newest.get(channel) or floor
            if oldest:
                params["oldest"] = oldest
            if pending:
                params["cursor"] = pending[1]
            try:
                body = await self._call("conversations.history", **params)
            except (AccessDenied, NotFound):
                # Left the channel, or it was archived between the sweep and now: forget it until re-listed.
                state.forget(channel)
                continue
            messages = [m for m in body.get("messages") or [] if m.get("ts")]
            seen = [str(m["ts"]) for m in messages]
            high = max([*seen, pending[0] if pending else ""], key=_ts_key, default="")
            more = str((body.get("response_metadata") or {}).get("next_cursor") or "")
            if more and high:
                state.pending[channel] = [high, more]
            else:
                state.pending.pop(channel, None)
                state.newest[channel] = max([high, state.newest.get(channel) or ""], key=_ts_key) or state.newest.get(channel, "")
                if not state.newest[channel]:
                    state.newest[channel] = oldest or f"{now:.6f}"  # nothing there: next time, only what is new
            for m in messages:
                if m.get("subtype") not in NOT_A_MESSAGE:
                    items.append(self._item(channel, m))
                    items.extend(self._reactions(channel, m))
        return ChangePage(items=tuple(await self._name_senders(items)), next_cursor=None, resume_cursor=state.encode())

    async def _conversations(self) -> list[dict]:
        """Every conversation the token's person is in — all four kinds, every page (``users.conversations``)."""
        return await self._channels("users.conversations", types=CONVERSATION_TYPES)

    async def _channels(self, method: str, *, types: str, pages: int = 5) -> list[dict]:
        """The ``channels`` of a listing method, following Slack's ``next_cursor`` for up to ``pages`` pages."""
        found: list[dict] = []
        cursor = ""
        for _ in range(pages):
            params: dict[str, Any] = {"types": types, "exclude_archived": "true", "limit": "200"}
            if cursor:
                params["cursor"] = cursor
            body = await self._call(method, **params)
            found.extend(c for c in body.get("channels") or [] if c.get("id"))
            cursor = str((body.get("response_metadata") or {}).get("next_cursor") or "")
            if not cursor:
                break
        return found

    async def _name_senders(self, items: list) -> list:
        """``items`` with a ``@handle`` on every sender that had none (``users.info``), at most
        ``NAMES_PER_PASS`` lookups a pass; the names are kept across passes (``_NAMES``)."""
        team = self.binding.account_key
        unnamed: list[str] = []
        for item in items:
            sender = getattr(getattr(item, "data", None), "sender", None)
            if isinstance(item, MessageItem) and sender is not None and not sender.name and sender.origin.key:
                key = sender.origin.key
                if key not in unnamed and (self.base_url, team, key) not in _NAMES:
                    unnamed.append(key)
        looked_up = unnamed[:NAMES_PER_PASS]
        for key, name in zip(looked_up, await asyncio.gather(*(self._handle(k) for k in looked_up))):
            if name:
                if len(_NAMES) >= _NAMES_CAP:
                    _NAMES.pop(next(iter(_NAMES)))
                _NAMES[(self.base_url, team, key)] = name
        return [self._named(item) if isinstance(item, MessageItem) else item for item in items]

    def _named(self, item: MessageItem) -> MessageItem:
        """``item`` with its sender's ``@handle`` when a pass already looked it up (``_NAMES``) — a pushed event
        carries no name and cannot wait on ``users.info``; a sender never seen is named by the next pass."""
        sender = item.data.sender
        if sender is None or sender.name or not sender.origin.key:
            return item
        name = _NAMES.get((self.base_url, self.binding.account_key, sender.origin.key))
        if not name:
            return item
        return item.model_copy(update={"data": item.data.model_copy(update={"sender": sender.model_copy(update={"name": name})})})

    async def _handle(self, user: str) -> str:
        try:
            info = (await self._call("users.info", user=user)).get("user") or {}
        except SourceError:
            return ""
        profile = info.get("profile") or {}
        handle = str(info.get("name") or profile.get("display_name") or profile.get("real_name") or "").strip()
        return f"@{handle}" if handle else ""

    async def _older(self, channel: str, before: datetime, params: dict[str, Any]) -> ChangePage:
        """One page of the channel's messages sent strictly before ``before``, newest first, as
        ``conversations.history`` answers ``latest`` with ``inclusive=false``. Neither reads nor moves
        the forward cursor; reactions stay with the forward read."""
        body = await self._call("conversations.history", **params, latest=f"{before.timestamp():.6f}")
        messages = [m for m in body.get("messages") or [] if m.get("ts") and m.get("subtype") not in NOT_A_MESSAGE]
        messages.sort(key=lambda m: _ts_key(str(m["ts"])), reverse=True)
        return ChangePage(items=tuple(self._item(channel, m) for m in messages if _ts_key(str(m["ts"])) < before.timestamp()))

    async def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(cursor, page_size=page_size, narrow=narrow)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _item(self, channel: str, message: dict) -> MessageItem:
        ts = str(message["ts"])
        author = str(message.get("user") or message.get("bot_id") or "")
        data = SlackMessageData(
            text=str(message.get("text") or ""),
            conversation=self.origin(str(message.get("thread_ts") or "") or ts, channel),
            sender=UserProfile(origin=self.origin(author, channel), name=str(message.get("username") or "") or None) if author else None,
            sent_at=_when(ts),
            attachments=tuple(self._file(channel, f) for f in message.get("files") or () if f.get("id")),
            raw=message,
        )
        return MessageItem(origin=self._message_origin(ts, channel), data=data)

    def _file(self, channel: str, f: dict) -> FileItem:
        media_type = str(f.get("mimetype") or "") or None
        size = f.get("size")
        data = MessageFileData(
            name=str(f.get("name") or f.get("title") or "") or None,
            media_type=media_type,
            size=size if isinstance(size, int) and size >= 0 else None,
            as_=kind_of(media_type or ""),
            fetch_error=UNSERVED.get(str(f.get("mode") or "")),
        )
        origin = self.origin(str(f["id"]), channel)
        if f.get("permalink"):
            origin = origin.model_copy(update={"url": str(f["permalink"])})
        return FileItem(origin=origin, data=data)

    def _reactions(self, channel: str, message: dict) -> list[ReactionItem]:
        """One SET per person: every emoji they hold on ``message``, in Slack's order."""
        ts = str(message["ts"])
        held: dict[str, list[str]] = {}
        for reaction in message.get("reactions") or ():
            glyph = unicode_of(str(reaction.get("name") or ""))
            for user in reaction.get("users") or ():
                held.setdefault(str(user), []).append(glyph)
        target = self.origin(ts, channel)
        return [
            ReactionItem(
                origin=self.origin(f"{ts}#reaction:{user}", channel),
                data=ReactionData(target=target, sender=UserProfile(origin=self.origin(user, channel)), emojis=tuple(emojis), mode=ReactionMode.SET),
            )
            for user, emojis in held.items()
        ]

    # ── files ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = CHUNK) -> AbstractAsyncContextManager[AsyncIterator[bytes]]:
        """The bytes of a file a message carried: ``files.info`` names the download URL, which takes
        the same bot token."""
        if not isinstance(file, FileItem):
            raise TypeError(f"expected FileItem, got {type(file).__name__}")
        return self._reader(file.origin, positive_int(chunk_size, "chunk_size", 16 * CHUNK))

    @asynccontextmanager
    async def _reader(self, origin: CloudOrigin, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        self._require_open()
        _, file_id = self._where(origin)
        if file_id is None:
            raise NotFound(f"{origin!r} names no file", origin=origin)
        info = (await self._call("files.info", file=file_id)).get("file") or {}
        url = str(info.get("url_private_download") or info.get("url_private") or "")
        if not url:
            raise NotFound(f"Slack offers no download for file {file_id}", origin=origin)
        async with http.stream(self._client, url, headers=self._auth(), origin=origin, chunk_size=chunk_size) as chunks:
            yield chunks

    # ── reactions ───────────────────────────────────────────────────────────
    async def react(self, target: CloudOrigin, emoji: str) -> None:
        self._require_open()
        channel, ts = self._message(target)
        name = name_of(emoji)
        if name is None:
            raise Rejected(f"{emoji!r} is not an emoji this Slack source knows a name for")
        await self._reaction("reactions.add", channel, ts, name)

    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None:
        """Take back ``emoji``, or with ``""`` every reaction the bot holds on ``target`` — read off
        ``reactions.get``, since only Slack knows which of the message's reactions are ours."""
        self._require_open()
        channel, ts = self._message(target)
        if emoji:
            name = name_of(emoji)
            if name is None:
                raise Rejected(f"{emoji!r} is not an emoji this Slack source knows a name for")
            names = [name]
        else:
            me = str((await self._call("auth.test")).get("user_id") or "")
            message = (await self._call("reactions.get", channel=channel, timestamp=ts, full="true")).get("message") or {}
            names = [str(r.get("name")) for r in message.get("reactions") or () if me and me in (r.get("users") or ())]
        for name in names:
            await self._reaction("reactions.remove", channel, ts, name)

    def _message(self, target: CloudOrigin) -> tuple[str, str]:
        channel, ts = self._where(target)
        if ts is None:
            raise NotFound(f"{target!r} names no message", origin=target)
        return channel, ts

    async def _reaction(self, method: str, channel: str, ts: str, name: str) -> None:
        body = await self._api(method, {"channel": channel, "timestamp": ts, "name": name}, verb="POST")
        error = str(body.get("error") or "")
        if not body.get("ok") and error not in ALREADY:
            raise _refusal(error or "unknown_error", channel)

    def _message_origin(self, ts: str, channel: str) -> CloudOrigin:
        # A formula, not a `chat.getPermalink` call: one request per message against a
        # one-request-per-minute budget is not affordable, and a link needs no workspace domain.
        link = f"https://slack.com/app_redirect?channel={channel}&message_ts={ts}"
        return self.origin(ts, channel).model_copy(update={"url": link})

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """The channel asked for ONE message: a missing invite is a setup state, not a failure. An
        everything row asks who the token is and for ONE of their conversations: a missing scope is named."""
        key, label = self.channel
        if not self._token():
            return Verdict(ready=False, detail="No Slack credential is available on this machine yet. Add a bot token or sign in with Slack.")
        if not key:
            return await self._verify_everything()
        error = str((await self._api("conversations.history", {"channel": key, "limit": 1})).get("error") or "")
        if error in NOT_A_MEMBER | NO_SUCH_CHANNEL:
            return Verdict(ready=False, detail=f"Invite the bot to #{label} (`/invite @<bot>`), then press Verify again.", pending=(key,))
        if error == "missing_scope":
            return Verdict(
                ready=False,
                detail="The Slack app is missing the history permission. It needs `channels:history` (and "
                "`groups:history` for private channels); an admin has to add it and everyone reconnects.",
            )
        if error:
            return Verdict(ready=False, detail=f"Slack refused the request: {error}")
        return Verdict(ready=True, detail=f"Reading #{label}.")

    async def _verify_everything(self) -> Verdict:
        me = await self._api("auth.test", {})
        error = str(me.get("error") or "")
        if error in REFUSED_CREDENTIAL:
            return Verdict(ready=False, detail=f"Slack refused the credential ({error}). Paste the User OAuth Token of your own Slack app, installed in your workspace.")
        if error:
            return Verdict(ready=False, detail=f"Slack refused the request: {error}")
        if not str(me.get("user_id") or ""):
            return Verdict(ready=False, detail="This token is a bot's, not a person's. Everything you are in needs your own app's User OAuth Token (xoxp-…).")
        listed = await self._api("users.conversations", {"types": CONVERSATION_TYPES, "exclude_archived": "true", "limit": "1"})
        error = str(listed.get("error") or "")
        if error == "missing_scope":
            return Verdict(ready=False, detail=f"Your Slack app is missing permissions. Its user scopes must include {', '.join(USER_SCOPES)}; add them and reinstall the app.")
        if error:
            return Verdict(ready=False, detail=f"Slack refused the request: {error}")
        who = f"@{me.get('user')}" if me.get("user") else "you"
        live = " Live: your app sends new messages here." if self._secret("webhook_url") else ""
        return Verdict(ready=True, detail=f"Reading everything {who} is in — DMs, group DMs and channels.{live}")

    async def whoami(self) -> tuple[UserProfile, ...]:
        me = await self._call("auth.test")
        team = str(me.get("team_id") or "") or "slack"
        user_id, bot_id, handle = (str(me.get(k) or "").strip() for k in ("user_id", "bot_id", "user"))
        profiles = []
        if user_id:
            profiles.append(UserProfile(origin=CloudOrigin(kind="slack", namespace=team, key=user_id), name=f"@{handle}" if handle else None))
        if bot_id:
            profiles.append(UserProfile(origin=CloudOrigin(kind="slack", namespace=team, key=bot_id)))
        return tuple(profiles)

    async def choices(self, field: str) -> list[dict]:
        """Every channel the token can SEE, not only those the bot has joined: "not a member yet"
        is a setup state the person fixes with an invite, so hiding it would hide the channel
        they opened the form to add."""
        if field != "channel":
            return []
        return [
            {"id": str(c["id"]), "name": str(c.get("name") or c["id"]), "detail": "private" if c.get("is_private") else ""}
            for c in await self._channels("conversations.list", types="public_channel,private_channel")
        ]

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is not None:
            channel, thread = self._where(data.conversation)
            return await self._deliver(channel, thread, data, data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a Slack direct message has exactly one recipient")
        opened = await self._call("conversations.open", verb="POST", users=data.recipients[0].origin.key)
        channel = str((opened.get("channel") or {}).get("id") or "")
        return await self._deliver(channel, None, data, self.channel_origin(channel))

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        channel, ts = self._where(origin)
        if ts is None:
            raise NotFound(f"{origin!r} names no message", origin=origin)
        body = await self._call("conversations.history", channel=channel, latest=ts, inclusive="true", limit=1)
        answered = next((m for m in body.get("messages") or [] if str(m.get("ts")) == ts), None)
        if answered is None:
            raise NotFound(f"no message {ts} in {channel}", origin=origin)
        root = str(answered.get("thread_ts") or ts)
        sent = await self._deliver(channel, root, data, self.origin(root, channel))
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _deliver(self, channel: str, thread: Optional[str], data: MessageData, conversation: CloudOrigin) -> MessageItem:
        if data.attachments:
            return await self._upload(channel, thread, data, conversation)
        return await self._post(channel, thread, data, conversation)

    async def _upload(self, channel: str, thread: Optional[str], data: MessageData, conversation: CloudOrigin) -> MessageItem:
        """Every file of ``data`` and its text in one message, in Slack's three steps."""
        uploaded = []
        for f in data.attachments:
            content = await asyncio.to_thread(read_file, f)
            name = f.data.name or "file"
            slot = await self._call("files.getUploadURLExternal", filename=name, length=len(content))
            url, file_id = str(slot.get("upload_url") or ""), str(slot.get("file_id") or "")
            if not url or not file_id:
                raise SourceUnavailable("Slack handed out no upload URL")
            # A pre-signed URL: it takes the bytes and no token.
            await http.request(self._client, "POST", url, content=content, headers={"Content-Type": "application/octet-stream"})
            uploaded.append({"id": file_id, "title": name})
        payload: dict[str, Any] = {"files": uploaded, "channel_id": channel}
        if thread:
            payload["thread_ts"] = thread
        if (data.text or "").strip():
            payload["initial_comment"] = data.text
        await self._call("files.completeUploadExternal", verb="POST", **payload)
        sent = SlackMessageData(text=data.text, conversation=conversation, attachments=data.attachments, sent_at=datetime.now(timezone.utc), recorded=True)
        return MessageItem(origin=self.origin(f"file:{uploaded[0]['id']}", channel), data=sent)

    async def _post(self, channel: str, thread: Optional[str], data: MessageData, conversation: CloudOrigin) -> MessageItem:
        payload: dict[str, Any] = {"channel": channel, "text": data.text}
        if thread:
            payload["thread_ts"] = thread
        # Post AS the persona this row answers for. Needs `chat:write.customize`: without it Slack
        # accepts the post and silently ignores both fields.
        if self.binding.persona.name:
            payload["username"] = self.binding.persona.name
        if self.binding.persona.icon:
            payload["icon_emoji"] = self.binding.persona.icon
        body = await self._call("chat.postMessage", verb="POST", **payload)
        ts = str(body.get("ts") or "")
        return MessageItem(origin=self._message_origin(ts, channel), data=MessageData(text=data.text, conversation=conversation, sent_at=_when(ts)))

    # ── live: the person's own app posts to a hub account claim ─────────────
    @classmethod
    def hub_claim(cls, config: Mapping[str, Any], secrets: Mapping[str, str]) -> Optional[dict]:
        """An everything row as an account claim on the hub's ``webhook/@slack`` chain (the generic
        ``public-webhook`` step asks). Before the app exists the claim is PENDING — ``key`` empty — so its
        URL can go into the app's manifest; once ``auth.test`` named the workspace and the user token is
        held, the claim is proven with it (the hub hands each event to this row). A channel row is polled: no claim."""
        if _channel_key(config):
            return None
        team, token = str(config.get("team_id") or ""), secrets.get("SLACK_USER_TOKEN")
        if team and token:
            return {"provider": "slack", "key": team, "proof": {"credential": token}}
        return {"provider": "slack", "key": ""}

    def events_from_webhook(self, payload: Any) -> list[DataSourceEvent]:
        """One Slack event — the hub's ``{"team_id", "event"}``, or Slack's own ``event_callback``
        envelope — as what it does to the records: a message (new, a file, a thread broadcast, a bot's) is an
        upsert, an edit upserts the new text, a deletion deletes, a reaction added or removed is a delta on
        its message. Total: another workspace's, and anything that is not a message, yields nothing."""
        if not isinstance(payload, dict):
            return []
        event = payload.get("event") if isinstance(payload.get("event"), dict) else None
        team = str(payload.get("team_id") or (event or {}).get("team") or "")
        mine = str(self.config.get("team_id") or "")
        if event is None or (mine and team and team != mine):
            return []
        kind, subtype = str(event.get("type") or ""), str(event.get("subtype") or "")
        if kind == "message":
            channel = str(event.get("channel") or "")
            if not channel:
                return []
            if subtype == "message_deleted":
                ts = str(event.get("deleted_ts") or "")
                return [DataSourceEvent(id=f"{channel}:{ts}:deleted", kind=EventKind.DELETE, origin=self._message_origin(ts, channel))] if ts else []
            message = event.get("message") if subtype == "message_changed" and isinstance(event.get("message"), dict) else event
            if not message.get("ts") or (subtype in NOT_A_MESSAGE) or (subtype == "message_changed" and str(message.get("subtype") or "") in NOT_A_MESSAGE):
                return []
            item = self._named(self._item(channel, message))
            events = [DataSourceEvent(id=f"{channel}:{message['ts']}", kind=EventKind.UPSERT, origin=item.origin, item=item)]
            events.extend(
                DataSourceEvent(id=f"{channel}:{message['ts']}:{r.origin.key}", kind=EventKind.UPSERT, origin=r.origin, item=r)
                for r in self._reactions(channel, message)
            )
            return events
        if kind in ("reaction_added", "reaction_removed"):
            item = event.get("item") if isinstance(event.get("item"), dict) else {}
            channel, ts, user = str(item.get("channel") or ""), str(item.get("ts") or ""), str(event.get("user") or "")
            name = str(event.get("reaction") or "")
            if not (channel and ts and user and name) or item.get("type") not in (None, "message"):
                return []
            report = ReactionItem(
                origin=self.origin(f"{ts}#reaction:{user}", channel),
                data=ReactionData(
                    target=self.origin(ts, channel), sender=UserProfile(origin=self.origin(user, channel)),
                    emojis=(unicode_of(name),), mode=ReactionMode.ADD if kind == "reaction_added" else ReactionMode.REMOVE,
                ),
            )
            return [DataSourceEvent(id=f"{channel}:{ts}#{kind}:{user}:{name}:{event.get('event_ts') or ''}", kind=EventKind.UPSERT, origin=report.origin, item=report)]
        return []

    # ── the slack-connect wizard's own steps ────────────────────────────────
    @setup_step("manifest")
    async def _manifest_step(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """The link that creates the person's Slack app from a manifest — the user scopes, the events, and
        the public URL the hub already holds as its Request URL — so Slack's console is three clicks: Next,
        Create and Install, Allow. Shown, never stored."""
        if not self.everything:
            return ReturnedValue.not_applicable("one channel as a bot: no app to create")
        url = self._secret("webhook_url")
        if not url:
            return ReturnedValue.not_yet("The public URL comes first.")
        # ``name`` is what the app is called in Slack's console — the later asks name it, which also keeps them
        # at their place in the run (after the app exists) rather than asked up front with the rest.
        name = app_name()
        shown = SetupShown(name=name, link=manifest_link(url, name))
        return ReturnedValue.satisfied(f"Create {name} in Slack from this link", ran=not check, value=SourceUpdateSpec(shown=shown))

    @setup_step("app", probes=True)
    async def _app_step(self, *, check: bool, values: Mapping[str, str], probe: bool = False) -> ReturnedValue:
        """The person's app: its User OAuth Token acts as them (``auth.test`` names the workspace and who
        they are there). Kept: the token in the credential (the ``app`` way), the workspace and user in
        config, the person as the row's one allowed sender. ``check`` asks whether the KEPT token holds;
        ``probe`` judges the TYPED token and keeps nothing (the question's Verify button)."""
        if not self.everything:
            return ReturnedValue.not_applicable("one channel as a bot: no app to connect")
        typed = str(values.get("user_token") or values.get("value") or "").strip()  # the wizard's bind, or the form's probe
        kept_token = str(self._secret("SLACK_USER_TOKEN") or "").strip()
        token = kept_token if check and not probe else typed or kept_token  # a check judges what is kept
        if not token:
            return ReturnedValue.not_yet("Paste the User OAuth Token (OAuth & Permissions).")
        if not token.startswith("xoxp-"):
            return ReturnedValue.not_yet("That is not a User OAuth Token: it starts with xoxp-. The Bot User OAuth Token (xoxb-) acts as a bot, not as you.")
        me = await self._api("auth.test", {}, verb="POST", token=token)
        if not me.get("ok"):
            error = str(me.get("error") or "unknown_error")
            return ReturnedValue.not_yet(f"Slack refused that token ({error}). Copy it again from OAuth & Permissions after installing the app.")
        team, user, handle = (str(me.get(k) or "") for k in ("team_id", "user_id", "user"))
        if not (team and user):
            return ReturnedValue.not_yet("Slack did not say which workspace that token acts in.")
        named = f"Connected as @{handle or user} in {me.get('team') or team}"
        if probe:
            return ReturnedValue.satisfied(named, ran=False)
        if check:
            kept = self.config.get("team_id") == team
            return ReturnedValue.satisfied(named, ran=False) if kept else ReturnedValue.not_yet("not kept yet")
        update = SourceUpdateSpec(
            config={"team_id": team, "user_id": user},
            secrets={"SLACK_USER_TOKEN": token},
            allowed_senders=[user],
            shown=SetupShown(name=f"@{handle or user}", connected=True),
        )
        return ReturnedValue.satisfied(named, value=update)

    # ── transport ───────────────────────────────────────────────────────────
    def _where(self, origin: object) -> tuple[str, Optional[str]]:
        """``(channel, message ts)`` an origin names; the ts is ``None`` for a channel itself."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        account = self.binding.account_key
        if origin.kind != self._scope.kind:
            raise ValueError(f"{origin!r} is outside this source's scope")
        if origin.namespace == account:
            return origin.key, None
        prefix = f"{account}/" if account else ""
        channel = origin.namespace[len(prefix):] if origin.namespace.startswith(prefix) else ""
        if not channel or "/" in channel:
            raise ValueError(f"{origin!r} is outside this source's scope")
        return channel, None if origin.key == channel else origin.key

    async def _api(self, method: str, payload: dict, *, verb: str = "GET", token: str = "") -> dict:
        """One Web API call, answered as Slack answered it — ``ok`` and all. ``token``: act with this one
        instead of the credential's (a token being probed before it is kept)."""
        headers = {"Authorization": f"Bearer {token}"} if token else self._auth()
        shape = {"json": payload} if verb == "POST" else {"params": payload}
        if self._client is not None:
            return await http.request_json(self._client, verb, f"{self.base_url}/{method}", headers=headers, **shape)
        async with http.client() as client:
            return await http.request_json(client, verb, f"{self.base_url}/{method}", headers=headers, **shape)

    def _token(self) -> str:
        """Who the source acts as, by the credential's chosen way: the person's own app's user token
        (``app``: ``SLACK_USER_TOKEN``), the bot token (``bot``: ``SLACK_BOT_TOKEN``) or the Slack sign-in's
        token (``signin``, or a row on the older ``connector`` auth). With no way chosen, whichever is held —
        bot, then user, then sign-in."""
        choice = self.credentials.choice
        bot, user = self._secret("SLACK_BOT_TOKEN") or "", self._secret("SLACK_USER_TOKEN") or ""
        signin = self.credentials.token.get_secret_value() if self.credentials.token is not None else ""
        if choice == "app":
            return user or signin
        if choice == "signin":
            return signin
        if choice == "bot":
            return bot or signin
        return bot or user or signin

    def _secret(self, key: str) -> Optional[str]:
        """A stored value of the credential (by the manifest's ``auth.vars`` key), or None."""
        secret = self.credentials.values.get(key)
        value = secret.get_secret_value().strip() if secret is not None else ""
        return value or None

    def _auth(self) -> dict:
        token = self._token()
        if not token:
            raise AccessDenied("No Slack credential on this machine. Add a bot token or sign in with Slack, then verify the source.")
        return {"Authorization": f"Bearer {token}"}

    async def _call(self, method: str, *, verb: str = "GET", **payload: Any) -> dict:
        body = await self._api(method, payload, verb=verb)
        if body.get("ok"):
            return body
        raise _refusal(str(body.get("error") or "unknown_error"), str(payload.get("channel") or ""))


def _refusal(error: str, channel: str) -> Exception:
    if error in NOT_A_MEMBER:
        return AccessDenied(f"The bot is not in {channel}. Invite it, then press Verify. ({error})")
    if error in NO_SUCH_CHANNEL:
        return NotFound(f"Slack has no channel {channel} this app can see ({error})")
    if error in REFUSED_CREDENTIAL:
        return AccessDenied(f"Slack refused the credential: {error}")
    if error in TRANSIENT:
        return SourceUnavailable(f"Slack: {error}")
    return Rejected(f"Slack refused the request: {error}")


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip() and not data.attachments:
        raise ValueError("a Slack message needs text or a file")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None:
        raise ValueError("sender, in_reply_to and sent_at are assigned by the provider")
    check_files(data.attachments, SlackSource.files, title="Slack", text=data.text)


def manifest(request_url: str, name: str = DEFAULT_APP_NAME) -> dict:
    """The Slack app manifest for a person's own app: acts as them (user scopes only), subscribes to what
    they are in, posts events to ``request_url``. No bot user, no Socket Mode, one workspace."""
    return {
        "display_information": {
            "name": name,
            "description": "Your Slack, in Flowpad: every conversation you are in, answered from there.",
            "background_color": "#1f2937",
        },
        "oauth_config": {"scopes": {"user": list(USER_SCOPES)}},
        "settings": {
            "event_subscriptions": {"request_url": request_url, "user_events": list(USER_EVENTS)},
            "org_deploy_enabled": False,
            "socket_mode_enabled": False,
            "token_rotation_enabled": False,
        },
    }


def manifest_link(request_url: str, name: str = DEFAULT_APP_NAME) -> str:
    """Slack's create-an-app page with the manifest filled in: pick a workspace, Create."""
    return "https://api.slack.com/apps?new_app=1&manifest_json=" + quote(json.dumps(manifest(request_url, name), separators=(",", ":")), safe="")


def _channel_key(config: Mapping[str, Any]) -> str:
    entry = config.get("channel") or ""
    return str((entry.get("id") if isinstance(entry, Mapping) else entry) or "").strip()


class _AllCursor:
    """Where an everything-mode row is in each conversation: ``all:{"s": <swept at>, "o": <rotation offset>,
    "c": {<channel>: <newest ts read, "" = never>}, "p": {<channel>: [<pending high-water ts>, <Slack page
    cursor>]}}``.
    Encoded under ``CURSOR_BUDGET``: the conversations whose newest message is oldest are forgotten first
    (their next read re-floors at the window — a bounded re-read, never a loss of position for the rest)."""

    def __init__(self) -> None:
        self.swept = 0.0
        self.newest: dict[str, str] = {}
        self.pending: dict[str, list[str]] = {}
        #: When Slack last saw activity in each conversation, most recent first — the sweep that just ran
        #: (not kept across passes).
        self.updated: dict[str, float] = {}
        #: Where the rotation over the quiet conversations stands (``o``), so every one gets its turn.
        self.offset = 0

    @classmethod
    def decode(cls, cursor: Optional[str]) -> "_AllCursor":
        state = cls()
        if cursor is None:
            return state
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        if not cursor.startswith(_ALL):
            raise InvalidCursor("not a Slack cursor")
        try:
            raw = json.loads(cursor[len(_ALL):])
        except ValueError as exc:
            raise InvalidCursor("malformed Slack cursor") from exc
        if not isinstance(raw, dict) or not isinstance(raw.get("c"), dict):
            raise InvalidCursor("malformed Slack cursor")
        state.swept = float(raw.get("s") or 0)
        state.offset = int(raw.get("o") or 0)
        state.newest = {str(k): str(v or "") for k, v in raw["c"].items()}
        pending = raw.get("p") if isinstance(raw.get("p"), dict) else {}
        state.pending = {str(k): [str(v[0]), str(v[1])] for k, v in pending.items() if isinstance(v, list) and len(v) == 2 and v[1]}
        return state

    def encode(self) -> str:
        """The cursor under ``CURSOR_BUDGET``: over it, the longest-unread conversations are forgotten first
        (read again from the window's start next time), then any other."""
        victims = sorted((c for c, ts in self.newest.items() if ts and c not in self.pending), key=lambda c: _ts_key(self.newest[c]))
        while True:
            body = {"s": int(self.swept), "o": self.offset, "c": self.newest, **({"p": self.pending} if self.pending else {})}
            text = _ALL + json.dumps(body, separators=(",", ":"), sort_keys=True)
            if len(text) <= CURSOR_BUDGET or not self.newest:
                return text
            self.forget(victims.pop(0) if victims else next(iter(self.newest)))

    def due(self, count: int) -> list[str]:
        """The conversations this pass reads: ones mid-page first, then ones that moved since they were read
        (the sweep's word), then never read (most recently active first), then the rest in turn — a rotation
        that advances by what it took, so a quiet conversation is never starved by busier ones."""
        order = {c: i for i, c in enumerate(self.updated)}
        active = [c for c, at in self.updated.items() if self.newest.get(c) and c not in self.pending and at > _ts_key(self.newest[c])]
        never = sorted((c for c, ts in self.newest.items() if not ts and c not in self.pending), key=lambda c: order.get(c, len(order)))
        head = [*self.pending, *active, *never]
        rest = sorted(self.newest.keys() - set(head))
        start = self.offset % len(rest) if rest else 0
        chosen = [*head, *rest[start:], *rest[:start]][:count]
        self.offset = (start + max(0, len(chosen) - len(head))) % len(rest) if rest else 0
        return chosen

    def forget(self, channel: str) -> None:
        self.newest.pop(channel, None)
        self.pending.pop(channel, None)


def _start(query: Optional[MessageQuery], cursor: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """``(oldest, newest so far)`` a traversal continues from."""
    if cursor is None:
        since = query.since if query is not None else None
        return (f"{since.timestamp():.6f}" if since else None), None
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    if cursor.startswith(_RESUME) and len(cursor) > len(_RESUME):
        return cursor[len(_RESUME):], None
    if cursor.startswith(_PAGE):
        state = _page_state(cursor)
        return state.get("oldest"), state.get("newest")
    raise InvalidCursor("not a Slack cursor")


def _page_state(cursor: str) -> dict:
    try:
        state = json.loads(cursor[len(_PAGE):])
    except ValueError as exc:
        raise InvalidCursor("malformed Slack page cursor") from exc
    if not isinstance(state, dict) or not state.get("cursor"):
        raise InvalidCursor("malformed Slack page cursor")
    return state


def _ts_key(ts: str) -> float:
    """A ``ts`` ordered numerically — "10.5" must not sort below "9.5"."""
    try:
        return float(ts)
    except (TypeError, ValueError):
        return 0.0


def _when(ts: str) -> Optional[datetime]:
    seconds = _ts_key(ts)
    return datetime.fromtimestamp(seconds, tz=timezone.utc) if seconds else None


__all__ = ["EVERYTHING_PAGE", "HISTORY_PAGE", "SLACK_API_BASE", "USER_EVENTS", "USER_SCOPES", "SlackMessageData", "SlackSource", "app_name", "manifest", "manifest_link"]
