"""``TaskManagerSource`` — the task ledger as a channel.

Nothing is fetched and nothing pushes from outside: the records are OUR OWN ``task.*`` events. The
source declares the topics (``bus_topics``) and turns each event of a task its principal created or
owns into one message (``events_from_bus``) — the task is the thread (keyed by task id, titled by
the task's title), the event's author is the sender. So a Chief of Staff's staff report in the same
stream inbox, the same threads and the same serve loop as every other channel.

Three traits shape how its messages are answered (generic hooks in ``agent_serve.answer``):

* ``quiet_events`` — ``created`` / ``started`` / ``note`` are the log, not a call to act; they land
  in the thread already read and do not wake the agent.
* ``turn_session`` — a task event is answered in the session the task came FROM
  (``origin_session``), so the agent answers with the memory of the request.
* ``replies_explicitly`` — what the agent writes in that turn goes nowhere by itself; it acts with
  ``flow task reply`` (to the owner) and ``flow conversation reply`` (to the person).

Sending on the channel (a human in the thread's composer, speaking for the agent) is a
``flow task reply`` — the ledger's ``replied`` event, whose echo arrives back through the bus.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any, ClassVar, Optional

from flow_sdk.builtin.source_item import MessageSpec
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.values.event import DataSourceEvent, EventKind
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.tasks.ledger import render_event

TASKS = "tasks"
PRINCIPALS = "principals"


class TaskMessageData(MessageData):
    """One task event as a message. ``subject`` is the task's title — the thread's name."""

    spec_kind: ClassVar[str] = "ingest.message.task"

    subject: Optional[str] = None
    task_id: str = ""
    task_event: str = ""
    #: The log, not a call to act: projected, never answered.
    quiet: bool = False
    #: The session the task came from — where the creator answers task news.
    origin_session: str = ""


class TaskMessageSpec(MessageSpec):
    """Said into a task's thread: a reply to its owner. The task IS the thread."""

    @classmethod
    def reply_to(cls, m, *, body: str, attachments=()) -> "TaskMessageSpec":
        thread_key = str(getattr(m, "thread_key", "") or "")
        return cls(to=[thread_key], body=body, thread_key=thread_key, attachments=list(attachments))


class TaskManagerConfig(SourceConfig):
    """Whose tasks this channel carries."""

    principal: str


class TaskManagerSource(MessageSource):

    Config = TaskManagerConfig
    provider = "task_manager"
    origin_kind = TASKS
    identity_config_key = "principal"
    #: Staff are not strangers — whoever the ledger lets touch a task may be heard.
    open_inbound = True
    #: A reply comes back as its own ``replied`` event through the bus.
    echoes_sends = True
    bus_topics: ClassVar[tuple[str, ...]] = ("task.*",)
    #: One source per principal (``principal`` config = its identity): machinery that needs "the
    #: channel carrying ``task.*`` news for agent X" finds this driver by that, not by name.
    principal_channel: ClassVar[bool] = True
    quiet_events: ClassVar[frozenset[str]] = frozenset({"created", "started", "note"})
    replies_explicitly: ClassVar[bool] = True

    @classmethod
    def outbound_spec(cls) -> type:
        return TaskMessageSpec

    @classmethod
    def turn_session(cls, message: Any) -> str:
        data = getattr(message, "data", None)
        return str(getattr(data, "origin_session", "") or "")

    @property
    def principal(self) -> str:
        return str(self.config.get("principal") or "").strip()

    def thread(self, task_id: str) -> CloudOrigin:
        return CloudOrigin(kind=TASKS, namespace=f"{self.principal}/{TASKS}", key=task_id)

    # ── inbound: the bus ────────────────────────────────────────────────────
    def events_from_bus(self, tag: str, data: dict) -> list[DataSourceEvent]:
        task_id, event = str(data.get("task_id") or ""), str(data.get("event") or "")
        if not task_id or not event or self.principal not in (data.get("creator"), data.get("owner")):
            return []
        author = str(data.get("author") or "")
        key = f"{task_id}:{data.get('comment_id') or secrets.token_hex(6)}"
        origin = CloudOrigin(kind=TASKS, namespace=f"{self.principal}/{TASKS}/{task_id}", key=key)
        item = MessageItem(
            origin=origin,
            data=TaskMessageData(
                text=render_event(data),
                subject=str(data.get("title") or "") or None,
                conversation=self.thread(task_id),
                sender=UserProfile(origin=CloudOrigin(kind=TASKS, namespace=PRINCIPALS, key=author), name=author, address=author),
                sent_at=datetime.now(timezone.utc),
                task_id=task_id,
                task_event=event,
                quiet=event in self.quiet_events,
                origin_session=str(data.get("origin_session") or ""),
            ),
        )
        return [DataSourceEvent(id=key, kind=EventKind.UPSERT, origin=origin, item=item)]

    # ── outbound: a reply is the ledger's ``replied`` ───────────────────────
    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        task_id = str(thread_key or to or "").strip()
        if not task_id:
            raise ValueError("a reply on the Tasks channel needs the task it is about")
        return MessageData(text=text, conversation=self.thread(task_id)), None

    async def send(self, data: MessageData) -> MessageItem:
        task_id = data.conversation.key if data.conversation is not None else ""
        return await self._reply(task_id, data.text or "")

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        return await self._reply(origin.namespace.rsplit("/", 1)[-1], data.text or "")

    async def _reply(self, task_id: str, text: str) -> MessageItem:
        from flow_sdk.tasks import ledger  # noqa: PLC0415

        task = await ledger.record(task_id, ledger.TaskEvent.REPLIED, author=self.principal, text=text)
        key = f"{task_id}:reply-{secrets.token_hex(6)}"
        return MessageItem(
            origin=CloudOrigin(kind=TASKS, namespace=f"{self.principal}/{TASKS}/{task_id}", key=key),
            data=TaskMessageData(text=text, conversation=self.thread(task_id), task_id=task.id, task_event="replied",
                                 sent_at=datetime.now(timezone.utc)),
        )
