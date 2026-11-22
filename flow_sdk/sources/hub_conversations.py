"""Hub conversations as a message source: what every driver that reads them shares.

A hub conversation's messages are the records, a reply is ``add_message``. A driver says which
conversations are its own (``_read_pool``: a desk's tickets, the conversations a login is a member of)
and what happens before it answers one; the cursor, the paging, the record and the send are here.

**Both writers, one row.** A conversation's messages also reach this machine through the hub
mirror, so every record carries the hub's own ids (``hub_conversation_id`` / ``hub_message_id``):
the application adopts the mirrored rows instead of minting twins.

**The hub is Flowpad's own backend, reached through a transport.** Its auth, token refresh and
local-privacy gate belong to whoever holds the login, so a source takes a ``HubTransport``
rather than a credential: the application passes ``AppHub``; a test hands over its own. Without
one, every call is ``SourceUnavailable``.

**One cursor for the pool.** Each pool entry carries a change token; the cursor remembers, per
conversation, the token it was last read at and its own message resume point, plus the pool's
watermark. A pass reads messages only of conversations whose token moved, and of conversations
it has never seen — so an idle conversation costs no fetch.

**No ``since`` on the hub's messages.** A conversation's resume point is a watermark on
``updated_date`` plus the ids seen AT it (a burst can share a second); an edited message
re-arrives because its stamp moved.
"""

from __future__ import annotations

import heapq
import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Mapping, NamedTuple, Optional, Protocol

from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    OutcomeUnknown,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import MessageQuery


class HubTransport(Protocol):
    """The Flowpad hub, as whoever holds the login reaches it. Raises the contract's errors."""

    async def get(
        self, entity_type: str, entity_id: str, action: str, *, params: Optional[Mapping[str, Any]] = None
    ) -> Any: ...

    async def post(self, entity_type: str, payload: dict, entity_id: str, action: str) -> Any: ...

    async def walk(self, entity_type: str) -> list[dict]:
        """Every row of a hub list the login can read; raises when the list did not come back whole."""
        ...

    def me(self) -> str:
        """The signed-in hub principal's id, or ``""`` when signed out."""
        ...

    def agent(self) -> str:
        """The signed-in agent Identity's id, or ``""`` when signed out or signed in as a person."""
        ...


def try_read_agent_login() -> Optional[str]:
    """The id of the agent Identity this machine is signed in to the hub as; ``None`` when it is
    signed out or signed in as a person."""
    from flow_sdk.cli.app_config import get_principal  # noqa: PLC0415

    principal = get_principal()
    if not principal or principal.get("type") != "identity":
        return None
    return str(principal.get("id") or "") or None


class AppHub:
    """The ``HubTransport`` of this machine: the shared client's bearer, refresh and local-privacy
    gate, with its failures in the contract's words a person can act on."""

    #: What a refusal names: the thing the login was refused.
    what: ClassVar[str] = "conversation"

    async def get(self, entity_type: str, entity_id: str, action: str, *, params: Optional[Mapping[str, Any]] = None):
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

        try:
            return await HubProxy.call("GET", entity_type, entity_id, action, params=params)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me()), what=self.what) from exc

    async def post(self, entity_type: str, payload: dict, entity_id: str, action: str):
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

        try:
            return await HubProxy.call("POST", entity_type, entity_id, action, payload=payload)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me()), what=self.what) from exc

    async def walk(self, entity_type: str) -> list[dict]:
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

        walked = await HubProxy.walk(entity_type)
        if walked.complete:
            return walked.rows
        if walked.error is None:
            raise SourceUnavailable(f"the hub's {entity_type} list did not come back whole")
        raise hub_refusal(walked.error, signed_in=bool(self.me()), what=self.what) from walked.error

    def me(self) -> str:
        """Who is signed in to the hub (a person, or the agent's Identity on its box), or "" when signed out."""
        try:
            from flow_sdk.cli.app_config import get_principal  # noqa: PLC0415

            return str((get_principal() or {}).get("id") or "")
        except Exception:  # noqa: BLE001
            return ""

    def agent(self) -> str:
        """The agent Identity signed in to the hub on this machine, or "" when signed out or a person is."""
        try:
            return try_read_agent_login() or ""
        except Exception:  # noqa: BLE001
            return ""


def hub_refusal(exc: Exception, *, signed_in: bool, what: str = "conversation") -> SourceError:
    """A hub failure as the contract error that decides whether a source keeps polling.

    The hub answers 401 "Forbidden access" to a caller with no role on the target, deliberately
    not distinguishing "no such thing" from "not a member" so existence does not leak: with a login
    in hand that is the membership answer, without one it is the login.
    """
    reason = str(getattr(exc, "reason", "") or "")
    status = int(getattr(exc, "status_code", 0) or 0)
    if status == 0:
        if getattr(exc, "kind", None) == "not_configured" or "not configured" in reason:
            return Rejected(f"Flowpad Cloud is not configured on this instance ({reason}).")
        return SourceUnavailable(f"the hub could not be reached: {reason}")
    if status in (401, 403):
        return AccessDenied(
            f"You are not a member of this {what}, or it does not exist."
            if signed_in
            else f"Log in to Flowpad Cloud to read this {what}."
        )
    if status == 404:
        return NotFound(f"This {what} no longer exists on the hub.")
    if status == 429 or status >= 500:
        return SourceUnavailable(f"the hub answered {status}: {reason}")
    return Rejected(f"the hub refused the request ({status}): {reason}")


class HubMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.hub"
    digest_exclude: ClassVar[frozenset[str]] = frozenset({"raw"})

    #: The hub conversation this message lives in, for adoption.
    hub_conversation_id: Optional[str] = None
    #: The hub's own id for the message, for adoption.
    hub_message_id: Optional[str] = None
    raw: Optional[dict] = None


class PoolEntry(NamedTuple):
    """One conversation of a source's pool: its hub id, its change token, and when it last moved."""

    conversation: str
    stamp: str
    updated_at: str


class Place(NamedTuple):
    """Where an origin points: a conversation, and one message of it (``None``: the conversation itself)."""

    conversation: str
    message: Optional[str]


class _HeldMessage(NamedTuple):
    """One message kept for a backward page: ordered by when it was sent, then by read order."""

    sent: datetime
    arrival: int
    item: MessageItem


def change_token(message_count: object, updated_at: str, status: object) -> str:
    """What a pool row says of its conversation's state: any message, edit or status change moves it."""
    return f"{message_count or 0}:{updated_at}:{status or ''}"


def newest_first(pool: list[PoolEntry]) -> list[PoolEntry]:
    return sorted(pool, key=lambda entry: (entry.updated_at, entry.conversation), reverse=True)


class HubConversationSource(MessageSource):
    """A pool of hub conversations as ONE stream. A driver names its pool and, when it has one, the
    step that precedes an answer."""

    durable_cursor = True
    #: A ``before`` narrow reads one page of older messages, filtered here over the pool.
    pages_backward = True
    #: Chat-grade while watched.
    attention_poll_seconds = 5
    #: What the cursor's token starts with: a cursor of another driver is not this one's.
    cursor_prefix: ClassVar[str]
    #: The words its errors name the driver and one of its conversations by.
    label: ClassVar[str] = "conversation"
    noun: ClassVar[str] = "conversation"
    #: The payload a message is emitted as.
    data_cls: ClassVar[type[HubMessageData]] = HubMessageData

    def __init__(self, binding: SourceBinding, hub: Optional[HubTransport] = None) -> None:
        super().__init__(binding)
        self._hub = hub

    @classmethod
    def resume_at(cls, watermark: str, tickets: Mapping[str, tuple[str, str, list[str]]]) -> str:
        """The pool cursor: the pool's ``watermark`` and, per conversation, ``(change token, message
        high-water, ids seen at it)``."""
        marks = {t: _ReadMark(h, b, stamp=s) for t, (s, h, b) in tickets.items()}
        return _PoolCursor(watermark, marks).encode(cls.cursor_prefix)

    @property
    def hub(self) -> HubTransport:
        if self._hub is None:
            raise SourceUnavailable("no hub transport reaches this source")
        return self._hub

    @property
    def root(self) -> str:
        """The container an origin that names no conversation sits in."""
        return self._scope.kind

    def origin(self, key: str, *within: str) -> CloudOrigin:
        return super().origin(key, *(within or (self.root,)))

    def conversation_origin(self, conversation: str) -> CloudOrigin:
        return self.origin(conversation, conversation)

    # ── what a driver says ──────────────────────────────────────────────────
    async def _read_pool(self) -> list[PoolEntry]:
        """Every conversation of this source, newest activity first."""
        raise NotImplementedError

    def require_ready(self) -> None:
        """Raises when the source cannot read or answer as it is configured and signed in."""

    async def prepare_answer(self, conversation: str) -> None:
        """What precedes a post to ``conversation``; nothing by default."""

    def signed_in_as(self) -> str:
        """The hub principal this source reads and answers as, or ``""``."""
        return self.hub.me()

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        from flow_sdk.builtin.source_item import HelpdeskMessageSpec  # noqa: PLC0415

        return HelpdeskMessageSpec

    def message_for(
        self,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        in_reply_to: str = "",
        conversation_id: str = "",
    ):
        """A reply goes to the hub conversation, which the hub threads by."""
        conversation = str(to or "").strip() or str(thread_key or "").strip()
        if not conversation:
            raise ValueError(f"a {self.label} reply needs the id of the {self.noun} it answers")
        return MessageData(text=text, conversation=self.conversation_origin(conversation)), None

    # ── read: the pool ──────────────────────────────────────────────────────
    def query(self) -> MessageQuery:
        """The whole pool: no one conversation. ``narrow={"conversation": origin}`` reads just that one."""
        return MessageQuery()

    async def fetch(
        self,
        cursor: Optional[str] = None,
        *,
        page_size: Optional[int] = None,
        narrow: Optional[Mapping[str, Any]] = None,
    ) -> ChangePage:
        """Walk the pool newest activity first; read messages only of a conversation whose change
        token differs from the one the cursor holds for it (a new one has none). A conversation read
        to its end takes the pool's token; one cut off by ``page_size`` keeps its old token and its
        advanced resume point, so the next page carries on inside it."""
        self._require_open()
        query = self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        if query is not None and query.before is not None:
            only = self._conversation_of(query.conversation) if query.conversation is not None else None
            return await self._read_older(query.before, limit, only)
        state = _PoolCursor.decode(cursor, self.cursor_prefix, self.label)
        only = self._conversation_of(query.conversation) if query is not None and query.conversation is not None else None
        since = query.since if query is not None else None
        pool = await self._read_pool()
        live = {entry.conversation for entry in pool}
        if only is None:
            # a conversation gone from the pool drops out
            state.marks = {c: m for c, m in state.marks.items() if c in live}
        items: list[MessageItem] = []
        more = False
        for entry in pool:
            conversation = entry.conversation
            if only is not None and conversation != only:
                continue
            mark = state.marks.get(conversation)
            if mark is not None and mark.stamp == entry.stamp:
                continue  # the pool says nothing moved: no fetch
            if len(items) >= limit:
                more = True
                break
            if since is not None and (_parse_time(entry.updated_at) or since) < since:
                state.marks[conversation] = _ReadMark(stamp=entry.stamp)  # quiet since before the window: nothing to read
                continue
            mark = mark or _ReadMark()
            children = rows_of(await self.hub.get("conversation", conversation, "messages"))
            fresh = [
                fm
                for fm in sorted(children, key=_stamp_of)
                if str(fm.get("id") or "").strip() and mark.is_new(_stamp_of(fm), str(fm["id"]).strip())
            ]
            taken = fresh[: limit - len(items)]
            for fm in taken:
                mark.advance(_stamp_of(fm), str(fm["id"]).strip())
                items.append(self._item_of(conversation, fm))
            if len(taken) == len(fresh):
                mark.stamp = entry.stamp
            else:
                more = True
            state.marks[conversation] = mark
            if more:
                break
        if only is None:
            state.watermark = max((entry.updated_at for entry in pool), default=state.watermark)
        token = state.encode(self.cursor_prefix)
        return ChangePage(items=tuple(items), next_cursor=token if more else None, resume_cursor=token)

    async def _read_older(self, before: datetime, limit: int, only: Optional[str]) -> ChangePage:
        """One page of the pool's messages sent strictly before ``before``, newest first, at most
        ``limit``. The hub has no ``before`` on a conversation's messages, so each is read and filtered
        here; the pool walks newest activity first, and once ``limit`` are held, a conversation whose
        last activity is older than the oldest held cannot better the page, so the walk stops. Neither
        reads nor moves the pool cursor."""
        # A bounded min-heap of the ``limit`` newest, keyed ``(sent, -arrival)``: its root is the one
        # to drop next — the oldest, and of equal times the latest read — so ties keep read order.
        held: list[_HeldMessage] = []
        arrival = 0
        if only is not None:
            self.require_ready()
            pool = [PoolEntry(only, "", "")]  # one conversation: read it directly, not via the pool
        else:
            pool = await self._read_pool()
        for entry in pool:
            active = _parse_time(entry.updated_at)
            if len(held) >= limit and active is not None and active < held[0].sent:
                break
            for fm in rows_of(await self.hub.get("conversation", entry.conversation, "messages")):
                sent = _parse_time(fm.get("created_date"))
                if str(fm.get("id") or "").strip() and sent is not None and sent < before:
                    arrival -= 1
                    kept = _HeldMessage(sent, arrival, self._item_of(entry.conversation, fm))
                    if len(held) < limit:
                        heapq.heappush(held, kept)
                    elif kept[:2] > held[0][:2]:
                        heapq.heapreplace(held, kept)
        held.sort(key=lambda kept: kept[:2], reverse=True)
        return ChangePage(items=tuple(kept.item for kept in held))

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

    def _item_of(self, conversation: str, fm: dict) -> MessageItem:
        fm_id, sender = str(fm["id"]).strip(), str(fm.get("sender_id") or "").strip()
        data = self.data_cls(
            text=str(fm.get("text") or ""),
            conversation=self.conversation_origin(conversation),
            sender=UserProfile(
                origin=self.origin(sender, conversation), name=str(fm.get("sender_name") or "") or sender
            )
            if sender
            else None,
            sent_at=_parse_time(fm.get("created_date")),
            hub_conversation_id=conversation,
            hub_message_id=fm_id,
            raw=fm,
        )
        return MessageItem(origin=self.origin(fm_id, conversation), data=data)

    # ── identity ────────────────────────────────────────────────────────────
    async def whoami(self) -> tuple[UserProfile, ...]:
        me = self.signed_in_as()
        return (UserProfile(origin=CloudOrigin(kind=self._scope.kind, namespace="hub-users", key=me)),) if me else ()

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        self._check_outgoing(data)
        if (data.conversation is None) == (not data.recipients):
            raise ValueError("address exactly one of a conversation or recipients")
        if data.conversation is None:
            raise Unsupported(f"this source answers {self.noun}s; it cannot open one to a person")
        return await self._post_answer(self._conversation_of(data.conversation), data.text or "", None)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        self._check_outgoing(data)
        if data.conversation is not None or data.recipients:
            raise ValueError("a reply is routed from the message it answers; leave conversation and recipients empty")
        place = self._place_of(origin)
        if place.message is None:
            raise NotFound(f"{origin!r} names no {self.noun} message", origin=origin)
        return await self._post_answer(place.conversation, data.text or "", origin)

    async def _post_answer(self, conversation: str, text: str, answered: Optional[CloudOrigin]) -> MessageItem:
        await self.prepare_answer(conversation)
        body = await self.hub.post(
            "conversation", {"text": text, "conversation_id": conversation}, conversation, "add_message"
        )
        message_id = str((body or {}).get("id") or "")
        if not message_id:
            raise OutcomeUnknown("the hub accepted the reply but returned no id for it")
        # Built by the poll's own `_item_of`, so the send-time copy IS the record the next poll reads —
        # hub ids included; without them the projection mints a twin of this reply.
        sent = {"text": text, "sender_id": self.signed_in_as(), **(body or {}), "id": message_id}
        item = self._item_of(conversation, sent)
        update = {"in_reply_to": answered, "sent_at": item.data.sent_at or datetime.now(timezone.utc)}
        return MessageItem(origin=item.origin, data=item.data.model_copy(update=update))

    def _check_outgoing(self, data: object) -> None:
        if not isinstance(data, MessageData):
            raise TypeError(f"expected MessageData, got {type(data).__name__}")
        if not (data.text or "").strip():
            raise ValueError(f"a {self.label} reply needs text")
        if data.sender is not None or data.in_reply_to is not None or data.sent_at is not None or data.attachments:
            raise ValueError("sender, in_reply_to, sent_at and attachments are assigned by the provider")

    # ── transport ───────────────────────────────────────────────────────────
    def _place_of(self, origin: object) -> Place:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        account = self.binding.account_key
        prefix = f"{account}/" if account else ""
        conversation = (
            origin.namespace[len(prefix) :]
            if origin.kind == self._scope.kind and origin.namespace.startswith(prefix)
            else ""
        )
        if not conversation or "/" in conversation:
            raise ValueError(f"{origin!r} is outside this source's scope")
        if conversation in self._root_names():
            return Place(conversation, None)
        return Place(conversation, None if origin.key == conversation else origin.key)

    def _conversation_of(self, origin: object) -> str:
        place = self._place_of(origin)
        if place.conversation in self._root_names() or place.message is not None:
            raise NotFound(f"{origin!r} is not a {self.noun} of this source")
        return place.conversation

    def _root_names(self) -> frozenset[str]:
        """The namespaces that name the source itself rather than one of its conversations."""
        return frozenset({self.root, self._scope.kind})


class _ReadMark:
    """One conversation in the pool cursor: the pool change token it was last read at (``""`` while a
    read of it is unfinished), and its message high-water stamp plus the ids seen AT it. Walk
    ascending: ``is_new`` answers, ``advance`` moves the mark."""

    def __init__(self, high_water: str = "", boundary_ids: Optional[list[str]] = None, *, stamp: str = "") -> None:
        self.high_water, self.boundary_ids, self.stamp = high_water, list(boundary_ids or []), stamp

    def is_new(self, stamp: str, entry_id: str) -> bool:
        if not (stamp and self.high_water):
            return True
        return stamp > self.high_water or (stamp == self.high_water and entry_id not in self.boundary_ids)

    def advance(self, stamp: str, entry_id: str) -> None:
        if stamp > self.high_water:
            self.high_water, self.boundary_ids = stamp, [entry_id]
        elif stamp == self.high_water:
            self.boundary_ids.append(entry_id)


class _PoolCursor:
    """A pool's one cursor: the pool watermark and a ``_ReadMark`` per conversation."""

    def __init__(self, watermark: str = "", marks: Optional[dict[str, _ReadMark]] = None) -> None:
        self.watermark, self.marks = watermark, dict(marks or {})

    @classmethod
    def decode(cls, cursor: object, prefix: str, label: str) -> "_PoolCursor":
        if cursor is None:
            return cls()
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        try:
            state = json.loads(cursor[len(prefix) :]) if cursor.startswith(prefix) else None
        except ValueError:
            state = None
        tickets = state.get("tickets") if isinstance(state, dict) else None
        if not isinstance(state, dict) or not isinstance(state.get("watermark"), str) or not isinstance(tickets, dict):
            raise InvalidCursor(f"not a {label} cursor")
        marks = {}
        for conversation, entry in tickets.items():
            if not (
                isinstance(entry, list)
                and len(entry) == 3
                and isinstance(entry[0], str)
                and isinstance(entry[1], str)
                and isinstance(entry[2], list)
            ):
                raise InvalidCursor(f"not a {label} cursor")
            marks[str(conversation)] = _ReadMark(entry[1], [str(i) for i in entry[2]], stamp=entry[0])
        return cls(state["watermark"], marks)

    def encode(self, prefix: str) -> str:
        tickets = {c: [m.stamp, m.high_water, m.boundary_ids] for c, m in sorted(self.marks.items())}
        return prefix + json.dumps({"watermark": self.watermark, "tickets": tickets}, sort_keys=True, separators=(",", ":"))


def rows_of(payload: object) -> list[dict]:
    """A hub list answer: a bare list, or a dict wrapping one under ``data``/``items``/``results``."""
    if isinstance(payload, dict):
        payload = next((v for k in ("data", "items", "results") if isinstance((v := payload.get(k)), list)), [])
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def _stamp_of(fm: dict) -> str:
    return str(fm.get("updated_date") or fm.get("created_date") or "")


def _parse_time(value: object) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


__all__ = [
    "AppHub",
    "HubConversationSource",
    "HubMessageData",
    "HubTransport",
    "Place",
    "PoolEntry",
    "change_token",
    "hub_refusal",
    "newest_first",
    "rows_of",
    "try_read_agent_login",
]
