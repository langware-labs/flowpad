"""``SlackSource`` — the channels a bot has been let into, read one page per pass.

**The rate cap shapes the source.** Since 2025-05-29 Slack allows a non-Marketplace app one
``conversations.history`` request a minute, at most 15 messages. So a pass reads one page of one
channel (``segment_budget = 1``, ``pages_per_pass = 1``): a busy channel is sampled, not
mirrored. The Events API is the answer to that, and a separate piece of work.

**Setup is a state, not a failure.** Slack will not let an app read a channel the bot was never
invited to, and a private channel needs a human to do the inviting. ``verify`` asks each channel
the cheapest question with the right answer (``conversations.history``, ``limit=1``) and names
the channels still waiting on an invite.

**200 is not success.** Slack answers ``{"ok": false, "error": …}`` with status 200, so every
call goes through one translation into the contract's errors.

Origins: a channel is ``(slack, <account>/<channel>, <channel>)``; a message and a thread root
are ``(slack, <account>/<channel>, <ts>)``. A message's ``conversation`` is its thread root — a
top-level message is its own — and ``in_reply_to`` is never guessed from the thread.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, NotFound, Rejected, SourceUnavailable, Unsupported
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

#: Slack's own base. Overridable only so a test can point at a local double.
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

_RESUME = "resume:"
_PAGE = "page:"


class SlackMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.slack"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    raw: Optional[dict] = None


class SlackSource(Source):
    provider = "slack"
    durable_cursor = True
    page_size = HISTORY_PAGE
    pages_per_pass = 1
    segment_budget = 1
    #: A Slack source is ABOUT its channels: a caller reuses the row whose channels name one.
    identity_config_key = "channels"
    connection = "slack"

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_after(cls, ts: str) -> str:
        """The resume cursor that continues after message ``ts``."""
        return _RESUME + ts

    @property
    def channels(self) -> list[tuple[str, str]]:
        """``(id, label)`` per configured channel, keyed by id — a renamed channel is the same one.
        An entry is a bare id or ``{"id", "name"}``; a caller that wrote one id as a string (or
        several as lines) names those ids, never the string's characters."""
        entries = self.config.get("channels") or []
        if isinstance(entries, str):
            entries = [line for line in entries.splitlines() if line.strip()]
        out: list[tuple[str, str]] = []
        for entry in entries:
            key = str((entry.get("id") if isinstance(entry, dict) else entry) or "").strip()
            if key:
                out.append((key, str(entry.get("name") or key) if isinstance(entry, dict) else key))
        return out

    def channel_origin(self, channel: str) -> CloudOrigin:
        return self.origin(channel, channel)

    # ── session ─────────────────────────────────────────────────────────────
    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [
            SegmentRef(key=key, label=label, query=MessageQuery(conversation=self.channel_origin(key)))
            for key, label in self.channels
        ]

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and not isinstance(query, MessageQuery):
            raise Unsupported(f"SlackSource does not support {type(query).__name__}")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        conversation = query.conversation if query is not None and query.conversation else None
        if conversation is None and self.channels:
            conversation = self.channel_origin(self.channels[0][0])
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
        return ChangePage(
            items=tuple(self._item(channel, m) for m in messages if m.get("subtype") not in NOT_A_MESSAGE),
            next_cursor=_PAGE + json.dumps({"cursor": more, "oldest": oldest, "newest": newest}) if more else None,
            resume_cursor=_RESUME + newest if newest else None,
        )

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
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
            raw=message,
        )
        return MessageItem(origin=self._message_origin(ts, channel), data=data)

    def _message_origin(self, ts: str, channel: str) -> CloudOrigin:
        # A formula, not a `chat.getPermalink` call: one request per message against a
        # one-request-per-minute budget is not affordable, and a link needs no workspace domain.
        link = f"https://slack.com/app_redirect?channel={channel}&message_ts={ts}"
        return self.origin(ts, channel).model_copy(update={"url": link})

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """All-or-nothing: a source reading three of five channels looks like it works, so nobody
        goes looking for the missing two."""
        if not self.channels:
            return Verdict(ready=False, detail="No channels selected yet — pick at least one for this source to read.")
        if self.credentials.token is None:
            return Verdict(ready=False, detail="No Slack credential is available on this machine yet. Connect Slack first.")
        pending: list[str] = []
        for key, label in self.channels:
            error = str((await self._api("conversations.history", {"channel": key, "limit": 1})).get("error") or "")
            if not error:
                continue
            if error in NOT_A_MEMBER | NO_SUCH_CHANNEL:
                pending.append(key)
                continue
            if error == "missing_scope":
                return Verdict(
                    ready=False,
                    detail="The Slack app is missing the history permission. It needs `channels:history` (and "
                    "`groups:history` for private channels); an admin has to add it and everyone reconnects.",
                )
            return Verdict(ready=False, detail=f"Slack refused the request: {error}")
        if pending:
            labels = dict(self.channels)
            names = ", ".join(f"#{labels.get(key, key)}" for key in pending)
            return Verdict(ready=False, detail=f"Invite the Flowpad bot to {names}, then press Verify again.", pending=tuple(pending))
        return Verdict(ready=True, detail=f"Reading {len(self.channels)} channel(s).")

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
        if field != "channels":
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
            return await self._post(channel, thread, data, data.conversation)
        if len(data.recipients) != 1:
            raise Unsupported("a Slack direct message has exactly one recipient")
        opened = await self._call("conversations.open", verb="POST", users=data.recipients[0].origin.key)
        channel = str((opened.get("channel") or {}).get("id") or "")
        return await self._post(channel, None, data, self.channel_origin(channel))

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
        sent = await self._post(channel, root, data, self.origin(root, channel))
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

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
        if self.credentials.token is None:
            raise AccessDenied("No Slack credential on this machine. Connect Slack, then verify the source.")
        headers = {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}
        shape = {"json": payload} if verb == "POST" else {"params": payload}
        if self._client is not None:
            return await http.request_json(self._client, verb, f"{SLACK_API_BASE}/{method}", headers=headers, **shape)
        async with http.client() as client:
            return await http.request_json(client, verb, f"{SLACK_API_BASE}/{method}", headers=headers, **shape)

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
    if not (data.text or "").strip():
        raise ValueError("a Slack message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


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
