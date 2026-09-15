"""``TeamsSource`` — the channel conversations a connected Microsoft account can see.

Four facts about Graph decide the shape:

* **The token is refreshable, so it lives on this machine.** A Teams access token lasts an hour
  and a poll has no request user, which is why the Microsoft connection is a desktop grant whose
  refresh token the poller can spend.
* **A channel is addressable only through its team,** and a channel id is not unique across teams.
  A segment is the composite ``{teamId}/{channelId}``; origins are scoped by it.
* **``/messages`` returns ROOTS; the conversation is in ``replies``.** ``$expand=replies`` brings a
  chain back in one request, which is what makes one page per pass enough. Teams has exactly two
  levels, so a message's conversation is always its root. ``page_size`` bounds conversations; a
  root's replies ride with it.
* **There is no incremental filter.** Graph takes neither ``$filter`` nor ``$orderby`` here and
  sorts chains by last activity, so "since" is a ``createdDateTime`` floor applied after the fetch.
  A channel receiving more than a page between passes is sampled, not mirrored.

What it cannot do: post as an agent. Graph posts as the signed-in user; there is no per-message
name or avatar, so the row's persona is ignored rather than promised.
"""
from __future__ import annotations

import asyncio
import html
import json
import re
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Optional

from flow_sdk.sources import http
from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.sources.values.segment import SegmentRef

#: Graph's own base. Overridable only so a test can point at a local double.
GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"
#: Conversations (roots) per page; Graph's ceiling for this collection is 50.
MESSAGE_PAGE = 20
#: ``messageType`` values that are not something a person said.
NOT_A_MESSAGE = frozenset({"systemEventMessage", "unknownFutureValue"})
CHATS = "chats"

_RESUME = "resume:"
_PAGE = "page:"
_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"(?i)<br\s*/?>|</p\s*>|</div\s*>")


class TeamsMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.teams"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    #: A root message's subject; a reply has none.
    subject: Optional[str] = None
    raw: Optional[dict] = None


class TeamsSource(Source):
    provider = "teams"
    durable_cursor = True
    page_size = MESSAGE_PAGE
    pages_per_pass = 1
    #: A Teams source is ABOUT its channels; each entry is ``{teamId}/{channelId}``.
    identity_config_key = "channels"
    connection = "microsoft"

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @classmethod
    def resume_after(cls, created: str) -> str:
        """The resume cursor that continues after messages created at ``created``."""
        return _RESUME + created

    @property
    def channels(self) -> list[tuple[str, str]]:
        entries = self.config.get("channels") or []
        if isinstance(entries, str):
            entries = [line for line in entries.splitlines() if line.strip()]
        out: list[tuple[str, str]] = []
        for entry in entries:
            key = str((entry.get("id") if isinstance(entry, dict) else entry) or "").strip()
            if key:
                out.append((key, str(entry.get("name") or key) if isinstance(entry, dict) else key))
        return out

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or [key for key, _ in self.channels[:1]]))

    def channel_origin(self, segment: str) -> CloudOrigin:
        return self.origin(split_segment(segment)[1], segment)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def lift_cursor(cls, state: dict) -> Optional[str]:
        return cls.resume_after(state["last_created"]) if state.get("last_created") else None

    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import TeamsMessageSpec  # noqa: PLC0415

        return TeamsMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """``to`` is the composite ``{teamId}/{channelId}`` (a Teams thread key is a bare message id
        and names no channel); ``thread_key`` is the ROOT the post goes under. Without one it is a new
        root, and only then does ``subject`` mean anything. Graph posts as the connected user."""
        segment = str(to or "").strip()
        if not all(split_segment(segment)):
            raise ValueError("a teams send needs `{teamId}/{channelId}` in `to`")
        if not (text or "").strip():
            raise ValueError("a teams send needs text")
        root = str(thread_key or "").strip() or str(in_reply_to or "").strip()
        conversation = self.origin(root, segment) if root else self.channel_origin(segment)
        return TeamsMessageData(text=text, subject=None if root else (subject or None), conversation=conversation), None

    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def segments(self) -> list[SegmentRef]:
        return [SegmentRef(key=key, label=label, query=MessageQuery(conversation=self.channel_origin(key))) for key, label in self.channels]

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> ChangePage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and not isinstance(query, MessageQuery):
            raise Unsupported(f"TeamsSource does not support {type(query).__name__}")
        limit = min(self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE), 50)
        conversation = query.conversation if query is not None and query.conversation else None
        if conversation is None and self.channels:
            conversation = self.channel_origin(self.channels[0][0])
        if conversation is None:
            if cursor is not None:
                raise InvalidCursor("this source has no channel to continue")
            return ChangePage(items=())
        segment, root = self._where(conversation)
        if segment == CHATS or root is not None:
            raise Unsupported("reading one Teams thread or chat is not supported")
        since, newest, link = _start(query, cursor)
        team, channel = split_segment(segment)
        body = await self._graph("GET", link) if link else await self._graph(
            "GET", f"teams/{team}/channels/{channel}/messages", params={"$top": str(limit), "$expand": "replies"}
        )
        items: list[MessageItem] = []
        for message_root in body.get("value") or []:
            for message in (message_root, *(message_root.get("replies") or [])):
                created = str(message.get("createdDateTime") or "")
                if not created or (since and created <= since):
                    continue
                newest = max(newest or "", created)
                if message.get("messageType") not in NOT_A_MESSAGE and message.get("id"):
                    items.append(self._item(segment, message_root, message))
        more = str(body.get("@odata.nextLink") or "")
        return ChangePage(
            items=tuple(items),
            next_cursor=_PAGE + json.dumps({"link": more, "since": since, "newest": newest}) if more else None,
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

    def _item(self, segment: str, root: dict, message: dict) -> MessageItem:
        message_id, root_id = str(message["id"]), str(root.get("id") or message["id"])
        sender = (message.get("from") or {}).get("user") or {}
        replied = str(message.get("replyToId") or "")
        data = TeamsMessageData(
            text=plain_text(message.get("body") or {}),
            subject=str(root.get("subject") or "") or None,
            conversation=self.origin(root_id, segment),
            sender=UserProfile(origin=self.origin(str(sender["id"]), segment), name=str(sender.get("displayName") or "") or None) if sender.get("id") else None,
            sent_at=_when(message.get("createdDateTime")),
            in_reply_to=self.origin(replied, segment) if replied else None,
            raw=message,
        )
        origin = self.origin(message_id, segment)
        link = str(message.get("webUrl") or "")
        return MessageItem(origin=origin.model_copy(update={"url": link}) if link else origin, data=data)

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """All-or-nothing across the channels, each asked for ONE message."""
        if not self.channels:
            return Verdict(ready=False, detail="No channels selected yet — pick at least one for this source to read.")
        if self.credentials.token is None:
            return Verdict(ready=False, detail="No Microsoft credential is available on this machine yet. Connect Microsoft first.")
        outcomes = await asyncio.gather(*(self._probe(key) for key, _ in self.channels))
        if any(isinstance(outcome, AccessDenied) for outcome in outcomes):
            return Verdict(
                ready=False,
                detail="Microsoft refused to read the channel. The connection is missing the `ChannelMessage.Read.All` "
                "permission, or a tenant admin has not consented to it — reconnect after an admin grants it.",
            )
        blocked = next((o for o in outcomes if o is not None and not isinstance(o, NotFound)), None)
        if blocked is not None:
            return Verdict(ready=False, detail=f"Microsoft refused the request: {blocked}")
        pending = tuple(key for (key, _), outcome in zip(self.channels, outcomes) if isinstance(outcome, NotFound))
        if pending:
            return Verdict(
                ready=False,
                detail=f"Cannot see {', '.join(pending)}. Join the team (or check the team/channel ids), then press Verify again.",
                pending=pending,
            )
        return Verdict(ready=True, detail=f"Reading {len(self.channels)} channel(s).")

    async def _probe(self, segment: str) -> Optional[Exception]:
        team, channel = split_segment(segment)
        if not (team and channel):
            return NotFound(f"`{segment}` is not `{{teamId}}/{{channelId}}`")
        try:
            await self._graph("GET", f"teams/{team}/channels/{channel}/messages", params={"$top": "1"})
        except (AccessDenied, NotFound, Rejected, SourceUnavailable) as exc:
            return exc
        return None

    async def whoami(self) -> tuple[UserProfile, ...]:
        me = await self._graph("GET", "me")
        user_id, upn = str(me.get("id") or "").strip(), str(me.get("userPrincipalName") or "").strip()
        return (UserProfile(origin=CloudOrigin(kind="teams", namespace="users", key=user_id), name=upn or None),) if user_id else ()

    async def choices(self, field: str) -> list[dict]:
        """Two levels, because Graph has no "every channel I can see": the joined teams, then each
        team's channels. The id offered is the composite a fetch can address."""
        if field != "channels":
            return []
        teams = [(str(t["id"]), str(t.get("displayName") or t["id"])) for t in (await self._graph("GET", "me/joinedTeams")).get("value") or [] if t.get("id")]
        listings = await asyncio.gather(*(self._graph("GET", f"teams/{team_id}/channels") for team_id, _ in teams))
        return [
            {
                "id": f"{team_id}/{channel['id']}",
                "name": f"{team_name} / {channel.get('displayName') or channel['id']}",
                "detail": "private" if channel.get("membershipType") == "private" else "",
            }
            for (team_id, team_name), listing in zip(teams, listings)
            for channel in listing.get("value") or []
            if channel.get("id")
        ]

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is None:
            if len(data.recipients) != 1:
                raise Unsupported("a Teams one-to-one chat has exactly one other member")
            me = await self._graph("GET", "me")
            members = [_member(str(me.get("id") or "")), _member(data.recipients[0].origin.key)]
            chat = await self._graph("POST", "chats", json={"chatType": "oneOnOne", "members": members})
            chat_id = str(chat.get("id") or "")
            return await self._post(f"chats/{chat_id}/messages", data, self.origin(chat_id, CHATS), CHATS)
        segment, root = self._where(data.conversation)
        if segment == CHATS:
            return await self._post(f"chats/{data.conversation.key}/messages", data, data.conversation, CHATS)
        team, channel = split_segment(segment)
        path = f"teams/{team}/channels/{channel}/messages" + (f"/{root}/replies" if root else "")
        return await self._post(path, data, data.conversation, segment, subject=None if root else getattr(data, "subject", None))

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        segment, message_id = self._where(origin)
        if segment == CHATS or message_id is None:
            raise NotFound(f"{origin!r} names no channel message", origin=origin)
        team, channel = split_segment(segment)
        answered = await self._graph("GET", f"teams/{team}/channels/{channel}/messages/{message_id}")
        root = str(answered.get("replyToId") or answered.get("id") or message_id)
        sent = await self._post(f"teams/{team}/channels/{channel}/messages/{root}/replies", data, self.origin(root, segment), segment)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    async def _post(self, path: str, data: MessageData, conversation: CloudOrigin, segment: str, *, subject: Optional[str] = None) -> MessageItem:
        payload: dict[str, Any] = {"body": {"contentType": "text", "content": data.text}}
        if subject:
            payload["subject"] = subject
        body = await self._graph("POST", path, json=payload)
        message_id = str(body.get("id") or "")
        if not message_id:
            raise OutcomeUnknown("Microsoft accepted the post but returned no id for it")
        sent = MessageData(text=data.text, conversation=conversation, sent_at=_when(body.get("createdDateTime")))
        return MessageItem(origin=self.origin(message_id, segment), data=sent)

    # ── transport ───────────────────────────────────────────────────────────
    def _where(self, origin: object) -> tuple[str, Optional[str]]:
        """``(segment, message id)`` an origin names; ``None`` for a channel itself. A chat is the
        ``chats`` segment, keyed by its chat id."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        account = self.binding.account_key
        prefix = f"{account}/" if account else ""
        rest = origin.namespace[len(prefix):] if origin.kind == self._scope.kind and origin.namespace.startswith(prefix) else ""
        if rest == CHATS:
            return CHATS, origin.key
        team, channel = split_segment(rest)
        if not (team and channel):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return rest, None if origin.key == channel else origin.key

    async def _graph(self, verb: str, path: str, **kwargs: Any) -> dict:
        """One Graph call; Graph's own sentence rides the error."""
        if self.credentials.token is None:
            raise AccessDenied("No Microsoft credential on this machine. Connect Microsoft, then verify the source.")
        url = path if path.startswith("http") else f"{GRAPH_API_BASE}/{path}"
        headers = {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}
        refused = (400, 401, 403, 404)
        if self._client is not None:
            response = await http.request(self._client, verb, url, headers=headers, ok_statuses=refused, **kwargs)
        else:
            async with http.client() as client:
                response = await http.request(client, verb, url, headers=headers, ok_statuses=refused, **kwargs)
        try:
            body = response.json() if response.content else {}
        except ValueError as exc:
            raise SourceUnavailable(f"Microsoft answered {verb} {path} with undecodable JSON") from exc
        if response.status_code >= 400:
            error = (body.get("error") or {}) if isinstance(body, dict) else {}
            message = str(error.get("message") or "").strip() or f"HTTP {response.status_code}"
            if response.status_code in (401, 403):
                raise AccessDenied(f"Microsoft: {message}")
            raise NotFound(f"Microsoft: {message}") if response.status_code == 404 else Rejected(f"Microsoft: {message}")
        return body if isinstance(body, dict) else {}


def split_segment(segment: str) -> tuple[str, str]:
    """``{teamId}/{channelId}`` → its halves, or two empties. A channel id holds a colon and an
    ``@`` but never a slash, so one split is unambiguous."""
    team, _, channel = str(segment or "").strip().partition("/")
    return (team, channel) if team and channel else ("", "")


def plain_text(body: dict) -> str:
    """A message body as text. Graph sends HTML for anything typed in the client, including one
    bare sentence; block boundaries become newlines before the tags go."""
    content = str(body.get("content") or "")
    if str(body.get("contentType") or "").lower() != "html":
        return content.strip()
    return html.unescape(_TAG.sub("", _BREAK.sub("\n", content))).strip()


def _check_outgoing(data: object) -> None:
    if not isinstance(data, MessageData):
        raise TypeError(f"expected MessageData, got {type(data).__name__}")
    if not (data.text or "").strip():
        raise ValueError("a Teams message needs text")
    if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
        raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")


def _start(query: Optional[MessageQuery], cursor: Optional[str]) -> tuple[Optional[str], Optional[str], str]:
    """``(since, newest so far, next link)`` a traversal continues from."""
    if cursor is None:
        since = query.since if query is not None else None
        return (since.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if since else None), None, ""
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    if cursor.startswith(_RESUME) and len(cursor) > len(_RESUME):
        return cursor[len(_RESUME):], None, ""
    if cursor.startswith(_PAGE):
        try:
            state = json.loads(cursor[len(_PAGE):])
        except ValueError as exc:
            raise InvalidCursor("malformed Teams page cursor") from exc
        if isinstance(state, dict) and state.get("link"):
            return state.get("since"), state.get("newest"), str(state["link"])
    raise InvalidCursor("not a Teams cursor")


def _member(user_id: str) -> dict:
    return {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        "roles": ["owner"],
        "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{user_id}')",
    }


def _when(value: Any) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


__all__ = ["GRAPH_API_BASE", "MESSAGE_PAGE", "TeamsMessageData", "TeamsSource", "plain_text", "split_segment"]
