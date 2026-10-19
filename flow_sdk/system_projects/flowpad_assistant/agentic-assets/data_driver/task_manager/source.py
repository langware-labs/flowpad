"""``TaskManagerSource`` — tasks as a channel, pulled like any other.

One driver, one config field: ``principal`` — whose tasks this channel carries. An agent
(``agent:<id>``, a Chief of Staff's channel) and the logged-in person (``user:<email>``) are two rows
of the same driver. The source LISTS what it carries (``_scan``) and the sync engine pulls it on its
cadence; the bus only says "pull now" (``bus_topics`` + ``wants``), so a missed event is latency,
never loss.

What it lists, per task the principal is in (``involves``):

* a **delegated** task (``owner`` set — the task ledger's) is exactly its working log: one message
  per ledger comment, rendered as ``[task <id> · <event> · by <author>] <title>``;
* any other task is a thread that opens with the task itself (``<task>:created``, carrying the task as
  its ref, so the thread can show and act on it), then every comment on it — including its history: one
  comment per change of status, assignee or title, written where the change was made (``task_changes``)
  and credited to who made it.

The task is the thread (``thread(task_id)``), so both people on a shared task read the same thread,
each on their own row. Sending into the thread is a comment on the task — the ledger's ``replied``
on a delegated one — written through the same auto-share path as the task editor's comments, so a
shared task's comment reaches the other person through the hub and comes back here on their side.

Three traits shape how an agent answers it (generic hooks in ``agent_serve.answer``):

* ``quiet_events`` — ``created`` / ``started`` / ``note`` are the log, not a call to act;
* ``turn_session`` — a task event is answered in the session the task came FROM (``origin_session``);
* ``replies_explicitly`` — what the agent writes in that turn goes nowhere by itself; it acts with
  ``flow task reply`` (to the owner) and ``flow conversation reply`` (to the person).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar, Mapping, Optional

from flow_sdk.builtin.source_item import MessageSpec
from flow_sdk.builtin.user import normalize_email
from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import NotFound, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.memory import check_outgoing
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import ChangePage
from flow_sdk.sources.values.query import DataQuery, MessageQuery
from flow_sdk.tasks.identity import LOCAL_USER, ref_kind
from flow_sdk.tasks.ledger import render_event
from flow_sdk.utils.serialization import iso_to_utc

TASKS = "tasks"
PRINCIPALS = "principals"
CREATED = "created"
#: Entity writes that can change what this channel lists.
WATCHED_TYPES = frozenset({"task", "comment"})


class TaskMessageData(MessageData):
    """One message of a task's thread. ``subject`` is the task's title — the thread's name."""

    spec_kind: ClassVar[str] = "ingest.message.task"

    subject: Optional[str] = None
    task_id: str = ""
    task_event: str = ""
    #: The log, not a call to act: projected, never answered.
    quiet: bool = False
    #: The session the task came from — where the creator answers task news.
    origin_session: str = ""


class TaskMessageSpec(MessageSpec):
    """Said into a task's thread: a comment on the task. The task IS the thread."""

    @classmethod
    def reply_to(cls, m, *, body: str, files=()) -> "TaskMessageSpec":
        thread_key = str(getattr(m, "thread_key", "") or "")
        return cls(to=[thread_key], body=body, thread_key=thread_key, files=list(files))


class TaskManagerConfig(SourceConfig):
    """Whose tasks this channel carries. ``email`` is derived, never typed: for the local person
    (``user:local``) it is who this instance is logged in as, read when the source opens."""

    derived: ClassVar[tuple[str, ...]] = ("email",)

    principal: str
    email: str = ""


def principal_email(principal: str) -> str:
    """``user:<email>`` → the email; anything else (an agent, ``user:local``) → ``""``."""
    kind, value = ref_kind(principal)
    return _fold(value) if kind == "user" and "@" in value else ""


def involves(task: Any, principal: str, email: str = "") -> bool:
    """Is ``principal`` in this task? Who asked or does it (``creator`` / ``owner``), or — for a person,
    known by ``email`` — who it is assigned to or was reported by."""
    if not principal:
        return False
    if principal in (getattr(task, "creator", None), getattr(task, "owner", None)):
        return True
    email = _fold(email) or principal_email(principal)
    return bool(email) and email in {_fold(getattr(task, "assignee", None)), _fold(getattr(task, "reporter", None))}


class TaskManagerSource(MessageSource, CollectionSource):

    Config = TaskManagerConfig
    provider = "task_manager"
    origin_kind = TASKS
    identity_config_key = "principal"
    supported_queries = (MessageQuery,)
    item_type = MessageItem
    #: Whoever may touch a task may be heard — the task's own sharing already decided who that is.
    open_inbound = True
    #: A send comes back as the comment it wrote, under the same key the next pull lists it by.
    echoes_sends = True
    #: Task and comment writes say "pull now"; the heartbeat poll is the safety net.
    bus_topics: ClassVar[tuple[str, ...]] = ("task.*", "entity.*")
    #: One source per principal (``principal`` config = its identity): machinery that needs "the
    #: channel carrying task news for X" finds this driver by that, not by name.
    principal_channel: ClassVar[bool] = True
    quiet_events: ClassVar[frozenset[str]] = frozenset({"created", "started", "note"})
    replies_explicitly: ClassVar[bool] = True
    #: A thread is addressed by itself (the task), never by a person: one only the principal has written
    #: in yet (a task it just made) can still be answered.
    addressed_by_thread: ClassVar[bool] = True
    #: The thread is named by its task and follows a rename.
    subject_tracks_item: ClassVar[bool] = True

    @classmethod
    def outbound_spec(cls) -> type:
        return TaskMessageSpec

    @classmethod
    def turn_session(cls, message: Any) -> str:
        data = getattr(message, "data", None)
        return str(getattr(data, "origin_session", "") or "")

    @classmethod
    def wants(cls, tag: str, data: dict) -> bool:
        """Does this bus event change what a Tasks channel lists? A ledger event, or a task/comment write."""
        if tag.startswith("task."):
            return True
        return tag.startswith("entity.") and str((data or {}).get("entity_type") or "") in WATCHED_TYPES

    @classmethod
    def configure(cls, row: Any) -> dict:
        """The local person's email: who this instance is logged in as, at the time the source opens —
        so a login (or a switch of account) needs no rewrite of the row."""
        config = getattr(row, "config", None) or {}
        if str(config.get("principal") or "") != LOCAL_USER:
            return {}
        from flow_sdk.tasks.identity import local_email  # noqa: PLC0415

        return {"email": local_email()}

    @property
    def principal(self) -> str:
        return str(self.config.get("principal") or "").strip()

    @property
    def email(self) -> str:
        """The principal's email when it is a person, else ``""``."""
        return _fold(self.config.get("email")) or principal_email(self.principal)

    def thread(self, task_id: str) -> CloudOrigin:
        return CloudOrigin(kind=TASKS, namespace=f"{self.principal}/{TASKS}", key=task_id)

    def query(self) -> Optional[DataQuery]:
        return MessageQuery()

    # ── where the next pull starts ──────────────────────────────────────────
    #: A pass hands back when it read (``resume_cursor``); the next lists only what was touched since —
    #: so a steady pull is a handful of items, ingested as arrivals (their tags project them, an update
    #: re-projects), never the whole window again.
    durable_cursor: ClassVar[bool] = True

    async def fetch(self, cursor: Optional[str] = None, *, page_size: Optional[int] = None,
                    narrow: Optional[Mapping[str, Any]] = None) -> ChangePage:
        """``CollectionSource.fetch`` over the window, or — from a resume point — over what changed since
        it (less a short overlap a write in flight could still land in — what it re-lists is unchanged, so
        it costs nothing). Every page says where the next traversal resumes: when this one started reading."""
        started = datetime.now(timezone.utc)
        floor: Optional[datetime] = None
        since = _resumes_at(cursor)
        if since is not None:
            # A recent resume point reads what changed since it; an old one (the heartbeat after a quiet
            # spell) re-reads the window, so nothing a missed nudge or a skewed clock hid stays hidden.
            floor = since - RESUME_OVERLAP if started - since <= RESUME_MAX_AGE else started - RESUME_WINDOW
            cursor = None
        elif cursor and cursor.startswith(CONTINUE):
            # The next page of a resumed pass: its floor travels with the page token, which is bound to it.
            floor_iso, _, cursor = cursor[len(CONTINUE):].partition("|")
            floor = iso_to_utc(floor_iso)
        if floor is not None:
            narrow = {**(narrow or {}), "since": floor}
        page = await super().fetch(cursor, page_size=page_size, narrow=narrow)
        next_cursor = page.next_cursor
        if next_cursor and floor is not None:
            next_cursor = f"{CONTINUE}{floor.isoformat()}|{next_cursor}"
        return ChangePage(items=page.items, next_cursor=next_cursor, resume_cursor=f"{RESUME}{started.isoformat()}")

    # ── the listing ─────────────────────────────────────────────────────────
    async def _scan(self, query: Optional[DataQuery]) -> list[tuple[str, Any]]:
        """The window's messages: tasks touched since ``since`` (or commented on since then) — only those
        load their bodies, so an idle pull over a long task list stays a row read."""
        since = getattr(query, "since", None)
        tasks = await self._involved_tasks()
        comments = await _comments_of(tasks, since=since)
        active = [t for t in tasks if since is None or str(t.typeid) in comments or _touched_since(t, since)]
        await asyncio.gather(*(_expand(task) for task in active))
        entries = [e for task in active for e in self._messages(task, comments.get(str(task.typeid), []))]
        return sorted((key, raw) for key, raw in entries if _in_window(raw, query))

    async def _lookup(self, key: str) -> Any:
        task = await self._task(key.split(":", 1)[0])
        if task is None or not await self._in(task):
            return None
        await _expand(task)
        comments = await _comments_of([task])
        return dict(self._messages(task, comments.get(str(task.typeid), []))).get(key)

    def _item(self, key: str, raw: Any) -> MessageItem:
        return MessageItem(origin=self.origin(key, TASKS, raw["task_id"]), data=raw["data"])

    def _key_of(self, origin: object) -> str:
        """A message's origin is narrowed by its task (``<account>/tasks/<task>``); the scope's own
        namespace names nothing, so it reads as an unknown key."""
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        base = self._scope.namespace
        task_id = origin.key.split(":", 1)[0]
        if origin.kind != self._scope.kind or origin.namespace not in (base, f"{base}/{TASKS}/{task_id}"):
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin.key

    async def _involved_tasks(self) -> list:
        from flow_sdk.builtin.task import Task  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        principal, email = self.principal, self.email
        terms = [ExpressionNode(op=QueryOp.EQ, operands=[field, principal]) for field in ("creator", "owner")]
        terms += [ExpressionNode(op=QueryOp.EQ, operands=[field, email]) for field in ("assignee", "reporter") if email]
        rows = [t for t in await Task.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.OR, operands=terms))) or []
                if involves(t, principal, email)]
        known = {t.id for t in rows}
        former = [i for i in await self._formerly_assigned() if i not in known]
        if former:
            rows += await Task.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", former]))) or []
        return rows

    async def _formerly_assigned(self) -> list[str]:
        """Tasks handed away from this person (an assignment comment ``from`` them): their thread keeps
        the hand-over and what came before it — after the reassignment they hear nothing more."""
        if not self.email:
            return []
        from flow_sdk.builtin.comment import Comment  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        match = ExpressionNode(op=QueryOp.AND, operands=[
            ExpressionNode(op=QueryOp.EQ, operands=["data.change", "assignee"]),
            ExpressionNode(op=QueryOp.EQ, operands=["data.from", self.email]),
        ])
        rows = await Comment.get_all(QueryFilter(match=match)) or []
        return sorted({str(c.parent_type_id or "").removeprefix("task-") for c in rows} - {""})

    @staticmethod
    async def _task(task_id: str) -> Any:
        """The task an id names, or ``None`` (an id that is not one names nothing)."""
        from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415
        from flow_sdk.builtin.task import Task  # noqa: PLC0415

        return await Task.get_by_id(task_id) if is_valid_uuid(task_id) else None

    async def _in(self, task: Any) -> bool:
        return involves(task, self.principal, self.email) or task.id in await self._formerly_assigned()

    def _messages(self, task: Any, comments: list) -> list[tuple[str, dict]]:
        """Every message of one task's thread, ``(key, raw)``."""
        title = str(task.title or "")
        out = [self._comment(task, c, title) for c in comments]
        if task.owner:  # delegated: exactly its ledger log
            return out
        reporter = _fold(task.reporter) or self.email or self.principal
        body = str(task.description or "").strip() or title
        # The root carries the task itself, so the thread can show — and act on — its status and owner.
        out.append(self._entry(task, CREATED, body, author=reporter, sent_at=iso_to_utc(task.created_date),
                               refs=(f"task-{task.id}",)))
        # Every change after that is history — a comment per change (``task_changes``), pulled with the task
        # when it arrives on a new machine. Nothing is read off the row's current state: a pass can see the row
        # move a beat before its comment is written, and a snapshot message would then say it twice.
        return out

    def _comment(self, task: Any, comment: Any, title: str) -> tuple[str, dict]:
        data = dict(comment.data or {})
        text = str(data.get("text") or comment.raw_content or "")
        event = str(data.get("task_event") or "")
        author = str(data.get("author") or "") or self._comment_author(task, comment)
        if event and not data.get("change"):
            text = render_event({"task_id": task.id, "event": event, "author": author, "text": text, "title": title})
        reply = str(data.get("in_reply_to") or "")
        return self._entry(task, str(comment.id), text, author=author, event=event,
                           sent_at=iso_to_utc(comment.created_date),
                           in_reply_to=self.origin(reply, TASKS, task.id) if reply else None,
                           quiet=event in self.quiet_events)

    def _comment_author(self, task: Any, comment: Any) -> str:
        """A comment with no ``data.author`` (the task editor's): written here is ours; one that came from
        the hub is the other person's on this task."""
        me = self.email or self.principal
        if not getattr(comment, "remote", False):
            return me
        people = [p for p in (_fold(task.assignee), _fold(task.reporter)) if p and p != me]
        return people[0] if people else me

    def _entry(self, task: Any, suffix: str, text: str, *, author: str, event: str = "", quiet: bool = False,
               sent_at: Optional[datetime] = None, in_reply_to: Optional[CloudOrigin] = None,
               refs: tuple[str, ...] = ()) -> tuple[str, dict]:
        key = f"{task.id}:{suffix}"
        data = TaskMessageData(
            text=text,
            subject=str(task.title or "") or None,
            conversation=self.thread(task.id),
            sender=self._sender(author),
            sent_at=sent_at,
            in_reply_to=in_reply_to,
            refs=refs,
            task_id=task.id,
            task_event=event,
            quiet=quiet,
            origin_session=str(getattr(task, "origin_session", "") or ""),
        )
        return key, {"task_id": task.id, "data": data}

    def _sender(self, author: str) -> UserProfile:
        """Who wrote a message. The principal itself is always keyed by its ref — the row's own address
        (``account_identities``), which no login change moves — so its own words read as its own."""
        mine = bool(author) and _fold(author) in {_fold(self.principal), self.email}
        key = self.principal if mine else (author or "unknown")
        return UserProfile(origin=CloudOrigin(kind=TASKS, namespace=PRINCIPALS, key=key), name=author or None,
                           address=author or None)

    # ── sending: a comment on the task ──────────────────────────────────────
    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        task_id = str(thread_key or to or "").strip()
        if not task_id:
            raise ValueError("a message on the Tasks channel needs the task it is about")
        return MessageData(text=text, conversation=self.thread(task_id)), None

    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=False)
        if data.conversation is None:
            raise Unsupported("a Tasks channel message goes into a task's thread, not to recipients")
        return await self._post(self._task_of_thread(data.conversation), data.text or "")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        check_outgoing(data, reply=True)
        key = self._key_of(origin)
        if await self._lookup(key) is None:
            raise NotFound("reply target does not exist", origin=origin)
        return await self._post(key.split(":", 1)[0], data.text or "", in_reply_to=key)

    def _task_of_thread(self, conversation: CloudOrigin) -> str:
        if conversation.kind != TASKS or conversation.namespace != f"{self.principal}/{TASKS}":
            raise NotFound("not a task thread of this channel", origin=conversation)
        return conversation.key

    async def _post(self, task_id: str, text: str, *, in_reply_to: str = "") -> MessageItem:
        from flow_sdk.builtin.comment import Comment  # noqa: PLC0415

        task = await self._task(task_id)
        if task is None or not involves(task, self.principal, self.email):
            raise NotFound("no such task on this channel", origin=self.thread(task_id))
        if task.owner:
            # A delegated task's log is the ledger's: a reply is its ``replied`` event.
            from flow_sdk.tasks import ledger  # noqa: PLC0415

            await ledger.record(task, ledger.TaskEvent.REPLIED, author=self.principal, text=text)
            comment = (await ledger.comments(task))[-1]
        else:
            author = self.email or self.principal
            data = {"author": author, "text": text, **({"in_reply_to": in_reply_to} if in_reply_to else {})}
            comment = await task.add_child_shared(Comment(raw_content=text, data=data))
        key, raw = self._comment(task, comment, str(task.title or ""))
        return self._item(key, raw)


# ── helpers ─────────────────────────────────────────────────────────────────
RESUME = "since:"
#: A page token of a resumed pass, carrying that pass's floor (``continue:<floor>|<token>``).
CONTINUE = "continue:"
#: How far back a resumed pull re-reads: a write committed just after a pass read still lands in the next.
RESUME_OVERLAP = timedelta(seconds=5)
#: A resume point older than this is a quiet spell's heartbeat, not a nudge: that pull re-reads the window.
RESUME_MAX_AGE = timedelta(minutes=4)
RESUME_WINDOW = timedelta(days=7)


def _resumes_at(cursor: Optional[str]) -> Optional[datetime]:
    """The time a resume cursor names, or ``None`` for no cursor / a page cursor of one traversal."""
    if not cursor or not cursor.startswith(RESUME):
        return None
    return iso_to_utc(cursor[len(RESUME):])


async def _comments_of(tasks: list, *, since: Optional[datetime] = None) -> dict[str, list]:
    """The comments of these tasks (written at or after ``since``), oldest first, by the task's typeid —
    one query. A comment whose words are not in ``data.text`` (the task editor's) loads its body."""
    if not tasks:
        return {}
    from flow_sdk.builtin.comment import Comment  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    match = ExpressionNode(op=QueryOp.IN, operands=["parent_type_id", [str(task.typeid) for task in tasks]])
    if since is not None:
        match = ExpressionNode(op=QueryOp.AND, operands=[match, ExpressionNode(op=QueryOp.GE, operands=["created_date", since])])
    rows = await Comment.get_all(QueryFilter(match=match)) or []
    await asyncio.gather(*(_expand(c) for c in rows if not (c.data or {}).get("text")))
    out: dict[str, list] = {}
    for comment in sorted(rows, key=lambda c: str(c.created_date or "")):
        out.setdefault(str(comment.parent_type_id or ""), []).append(comment)
    return out


async def _expand(entity: Any) -> None:
    """Load a row's blob fields (a task's description, a comment's body) — a list query leaves them out."""
    try:
        await entity.expand_blobs()
    except Exception:  # noqa: BLE001 — a body that cannot load reads as its title / empty, never fails the pull
        pass


def _touched_since(task: Any, since: datetime) -> bool:
    """Written at or after ``since`` here — ``fetched_at`` is when a hub-merged change landed on THIS machine,
    whose ``updated_date`` is the other side's clock."""
    return any((when := iso_to_utc(getattr(task, f, None))) is not None and when >= since
               for f in ("updated_date", "created_date", "fetched_at"))


def _in_window(raw: dict, query: Optional[DataQuery]) -> bool:
    since = getattr(query, "since", None)
    sent_at = raw["data"].sent_at
    return since is None or sent_at is None or sent_at >= since


def _fold(value: Any) -> str:
    return normalize_email(str(value or "")) or ""
