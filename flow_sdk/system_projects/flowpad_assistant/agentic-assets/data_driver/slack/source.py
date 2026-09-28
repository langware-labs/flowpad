"""``SlackSource`` — one channel a bot has been let into, read one page per pass.

**The rate cap shapes the source.** Since 2025-05-29 Slack allows a non-Marketplace app one
``conversations.history`` request a minute, at most 15 messages. So a pass reads one page of the
channel (``pages_per_pass = 1``): a busy channel is sampled, not mirrored. The Events API is the answer to that, and a separate piece of work.

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
pass reads, so a reaction added later, and a reaction taken back, are not seen: that is Slack's
``reaction_added``/``reaction_removed`` over the Events API (ADD/REMOVE), a separate piece of work.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional, Union

from pydantic import StringConstraints

from flow_sdk.sources import http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import ChoiceEntry, SourceConfig
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, NotFound, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.files import FileSupport, check_files, kind_of, read_file
from flow_sdk.sources.protocols import Verdict
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
#: Slack's ceiling per ``conversations.history`` call for a non-Marketplace app.
HISTORY_PAGE = 15

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


class SlackMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.slack"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw", "recorded"})

    raw: Optional[dict] = None
    #: A sent message whose record is the provider's echo, not a copy made at send (an upload: Slack
    #: names no message ``ts`` for it, so a copy would be a second row once the echo lands).
    recorded: bool = False


class SlackConfig(SourceConfig):
    """What a slack source is configured with."""

    retired_list = ("channels", "channel")

    channel: Union[Annotated[str, StringConstraints(pattern=r"^[CGD][A-Z0-9]{6,}$")], ChoiceEntry]
    #: Who may drive the channel; the row keeps it as ``allowed_senders``.
    allowed_senders: list[str] = []
    #: Empty is Slack itself; a test points a row at a local double. Never a secret.
    base_url: str = ""


class SlackSource(MessageSource):

    Config = SlackConfig
    provider = "slack"
    durable_cursor = True
    page_size = HISTORY_PAGE
    pages_per_pass = 1
    #: A Slack source is ABOUT its channel: a caller reuses the row that names it.
    identity_config_key = "channel"
    connection = "slack"
    #: Every kind goes up as a plain file; up to ten, and the text, in one message. No per-file caption.
    files = FileSupport(kinds=frozenset({FileKind.IMAGE, FileKind.VIDEO, FileKind.AUDIO, FileKind.DOCUMENT}), per_message=10)
    #: A reply threads; it never quotes the message it answers.
    quotes = False
    #: A person keeps any number of reactions on a message.
    reactions_per_actor = 0

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_after(cls, ts: str) -> str:
        """The resume cursor that continues after message ``ts``."""
        return _RESUME + ts

    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or SLACK_API_BASE).rstrip("/")

    @property
    def channel(self) -> tuple[str, str]:
        """``(id, label)`` of the configured channel, keyed by id — a renamed channel is the same one.
        The entry is a bare id or ``{"id", "name"}``; ``("", "")`` when none is configured."""
        entry = self.config.get("channel") or ""
        key = str((entry.get("id") if isinstance(entry, dict) else entry) or "").strip()
        return (key, (str(entry.get("name") or key) if isinstance(entry, dict) else key)) if key else ("", "")

    def query(self) -> MessageQuery:
        key = self.channel[0]
        return MessageQuery(conversation=self.channel_origin(key) if key else None)

    def channel_origin(self, channel: str) -> CloudOrigin:
        return self.origin(channel, channel)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import SlackMessageSpec  # noqa: PLC0415

        return SlackMessageSpec

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
            if cursor is not None:
                raise InvalidCursor("this source has no channel to continue")
            return ChangePage(items=())
        channel, thread = self._where(conversation)
        if thread is not None:
            raise Unsupported("reading a single Slack thread is not supported")

        params: dict[str, Any] = {"channel": channel, "limit": min(limit, HISTORY_PAGE), "inclusive": "false"}
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
        """The channel asked for ONE message: a missing invite is a setup state, not a failure."""
        key, label = self.channel
        if not key:
            return Verdict(ready=False, detail="No channel selected yet — pick one for this source to read.")
        if self.credentials.token is None:
            return Verdict(ready=False, detail="No Slack credential is available on this machine yet. Connect Slack first.")
        error = str((await self._api("conversations.history", {"channel": key, "limit": 1})).get("error") or "")
        if error in NOT_A_MEMBER | NO_SUCH_CHANNEL:
            return Verdict(ready=False, detail=f"Invite the Flowpad bot to #{label}, then press Verify again.", pending=(key,))
        if error == "missing_scope":
            return Verdict(
                ready=False,
                detail="The Slack app is missing the history permission. It needs `channels:history` (and "
                "`groups:history` for private channels); an admin has to add it and everyone reconnects.",
            )
        if error:
            return Verdict(ready=False, detail=f"Slack refused the request: {error}")
        return Verdict(ready=True, detail=f"Reading #{label}.")

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
        body = await self._call(
            "conversations.list", types="public_channel,private_channel", exclude_archived="true", limit="200"
        )
        return [
            {"id": str(c["id"]), "name": str(c.get("name") or c["id"]), "detail": "private" if c.get("is_private") else ""}
            for c in body.get("channels") or []
            if c.get("id")
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

    async def _api(self, method: str, payload: dict, *, verb: str = "GET") -> dict:
        """One Web API call, answered as Slack answered it — ``ok`` and all."""
        headers = self._auth()
        shape = {"json": payload} if verb == "POST" else {"params": payload}
        if self._client is not None:
            return await http.request_json(self._client, verb, f"{self.base_url}/{method}", headers=headers, **shape)
        async with http.client() as client:
            return await http.request_json(client, verb, f"{self.base_url}/{method}", headers=headers, **shape)

    def _auth(self) -> dict:
        if self.credentials.token is None:
            raise AccessDenied("No Slack credential on this machine. Connect Slack, then verify the source.")
        return {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}

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


__all__ = ["HISTORY_PAGE", "SLACK_API_BASE", "SlackMessageData", "SlackSource"]
