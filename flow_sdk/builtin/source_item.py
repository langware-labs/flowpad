"""SourceItem — one record ingested from a cloud DataSource.

Generic and discriminated by ``kind`` (``content.feed.item``, later
``content.message.chat``) rather than one entity type per provider: providers
differ only in ``kind`` and ``raw``, and a single queryable table is what any
later projection over ingested records will need.

**Identity is the natural key, looked up — not derived.** The id is an ordinary
``uuid4``; what makes a re-poll, a replay and a reconciliation sweep converge on
one row is ``find_existing``, which resolves ``(data_source, stream, external
id)`` to the row that already holds it. Same guarantee as the old v5-derived id
(idempotency with no delivery ledger and no dedupe table), relocated from id
arithmetic to a lookup — so rows written before the change still resolve, and
nothing has to re-derive an id it does not hold.

**Snapshot vs local state.** ``SourceItemSpec`` — the type's ``asset_spec`` — IS
the snapshot: what a driver emits and what the ingestor copies onto the row
whenever the content digest moves. ``read`` and ``starred`` are ours, outside
the header, and so survive re-delivery structurally rather than by a hand-kept
field map.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict, model_validator

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.legacy_fields import adopt_renamed
from flow_sdk.schema.data_spec.dataset_spec import FileRef
from flow_sdk.schema.data_spec.source_item_spec import (  # noqa: F401 — re-exported; the row and its snapshot read as one module
    NonBlank,
    SourceItemSpec,
)
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType


class MessageSpec(DataSpec):
    """An OUTBOUND message, as a value — what a script hands ``Inbox.send``.

    The channel-generic base of the outbound hierarchy — outbound only,
    deliberately. Inbound messages keep arriving as ``SourceItemSpec`` until
    the full inbound family lands; this class exists so the outbound half of a
    conversation is a spec too — send shape and receive shape stay one family,
    and threading is visible data rather than verb arguments.

    Subclasses add what their channel genuinely needs (email a ``subject``)
    and own their ``reply_to`` constructor, because channels disagree on WHO a
    reply targets: email replies to the author's address, a chat channel
    replies to the chat itself.

    Identity fields (``external_id`` and friends) are deliberately absent: a
    message's identity is born at the provider — ``send()`` returns it.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    to: list[str]
    body: str
    thread_key: str = ""
    reply_to_external_id: str = ""
    #: Pointers, never bytes — resolved at the send edge. Unsupported channels
    #: refuse loudly rather than dropping them.
    attachments: list["FileRef"] = []


class EmailMessageSpec(MessageSpec):
    """Outbound email: the generic shape plus a subject line.

    The sent copy re-ingests as a full ``SourceItemSpec`` on the next poll —
    the mailbox is the record.
    """

    subject: str = ""

    @classmethod
    def reply_to(cls, m, *, body: str, attachments=()) -> "EmailMessageSpec":
        """A reply to inbound message ``m`` — a pure constructor, no I/O.

        Email replies target the AUTHOR's address. The provider's thread
        handle rides ``thread_key`` and the replied-to message's own id rides
        ``reply_to_external_id`` (what e.g. AgentMail's reply endpoint keys on).
        """
        subject = str(getattr(m, "name", "") or "")
        if subject and not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"
        return cls(
            to=[str(getattr(m, "author_external_id", "") or "")],
            body=body,
            subject=subject,
            thread_key=str(getattr(m, "thread_key", "") or ""),
            reply_to_external_id=str(getattr(m, "external_id", "") or ""),
            attachments=list(attachments),
        )


class TelegramMessageSpec(MessageSpec):
    """Outbound Telegram message: the generic shape, chat-targeted replies.

    No extra fields — Telegram has no subject; parse modes and media are
    explicit non-goals for now (the driver sends plain text).
    """

    @classmethod
    def reply_to(cls, m, *, body: str, attachments=()) -> "TelegramMessageSpec":
        """A reply to inbound message ``m`` — a pure constructor, no I/O.

        Telegram replies target the CHAT, not the author: ``to`` carries the
        chat id (the leading component of ``thread_key``), and the replied-to
        message's ``external_id`` (``"<chat_id>/<message_id>"``) rides
        ``reply_to_external_id`` for the driver's ``reply_to_message_id``.
        """
        thread_key = str(getattr(m, "thread_key", "") or "")
        chat_id = thread_key.split("/", 1)[0]
        return cls(
            to=[chat_id],
            body=body,
            thread_key=thread_key,
            reply_to_external_id=str(getattr(m, "external_id", "") or ""),
            attachments=list(attachments),
        )


class SlackMessageSpec(MessageSpec):
    """Outbound Slack message: the generic shape, thread-targeted replies.

    No extra fields — Slack has no subject; blocks, attachments and mentions
    are explicit non-goals for now (the driver posts plain text).
    """

    @classmethod
    def reply_to(cls, m, *, body: str, attachments=()) -> "SlackMessageSpec":
        """A reply to inbound message ``m`` — a pure constructor, no I/O.

        Slack replies target the CHANNEL, in the message's thread: ``to``
        carries the channel id, which on an inbound record is ``segment_key``
        (a Slack ``thread_key`` is a bare ``ts`` and names no channel), and
        ``thread_key`` rides through so the post lands as a threaded reply.
        """
        return cls(
            to=[str(getattr(m, "segment_key", "") or "")],
            body=body,
            thread_key=str(getattr(m, "thread_key", "") or ""),
            reply_to_external_id=str(getattr(m, "external_id", "") or ""),
            attachments=list(attachments),
        )


class SourceItem(Entity):
    """The ROW; the snapshot the medium persists is ``SourceItemSpec``
    (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.SOURCE_ITEM.value)

    # ── envelope (the routing header) ──────────────────────────────────────
    kind: str = APIField(default="", description="Ontology kind, e.g. content.feed.item")
    provider: str = APIField(default="", description="Driver key: rss | hackernews | …")
    data_source_id: str = APIField(default="")
    segment_key: str = APIField(default="", description="Feed URL, channel id — the cursor's unit")
    segment_label: str = APIField(default="")
    external_id: str = APIField(default="", description="Provider-native stable id")
    thread_key: Optional[str] = APIField(default=None, description="Grouping axis for the inbox projection")
    # The provider's id for the record this replies to. Provenance for quoting
    # and for repairing a thread whose parent arrives late — NOT how threading
    # is decided (`thread_key` is). Deliberately absent from DIGESTED_FIELDS:
    # it never changes for a given record, and adding a digested field rewrites
    # the whole corpus once. The accepted consequence is that rows ingested
    # before this field existed never backfill it.
    reply_to_external_id: Optional[str] = APIField(default=None)
    permalink: Optional[str] = APIField(default=None)
    occurred_at: Optional[str] = APIField(default=None, description="ISO-8601; the ordering key")

    # ── who ────────────────────────────────────────────────────────────────
    author_external_id: Optional[str] = APIField(default=None)
    author_display: Optional[str] = APIField(default=None)

    # ── body ───────────────────────────────────────────────────────────────
    # `name` (declared on Entity) is the FTS title. `body` must reach FTS, which
    # is why it is in the header — see the type_info module.
    body: str = APIField(default="")
    # The provider payload, verbatim. Persist.FALSE keeps it a DB column: it
    # never lands in metadata.json and never pollutes the FTS row.
    raw: Optional[dict] = APIField(default=None, persist=Persist.FALSE, sharing=Sharing.PRIVATE)

    # ── idempotency ────────────────────────────────────────────────────────
    # sha256 over the NORMALIZED fields only, never over `raw` — provider
    # payloads carry volatile keys (scores, reaction counts, re-serialized
    # whitespace) that would flip the digest on every poll and defeat the gate.
    content_digest: str = APIField(default="", persist=Persist.TRUE)

    # ── local state — PRESERVED across re-delivery ─────────────────────────
    read: bool = APIField(default=False, persist=Persist.TRUE)
    starred: bool = APIField(default=False, persist=Persist.TRUE)

    _api_visible: ClassVar[bool] = True

    @model_validator(mode="before")
    @classmethod
    def _adopt_legacy_stream_key(cls, data):
        """Rows written before the segment rename carry ``stream_key``.

        Without this they load with an empty ``segment_key`` — and for
        ``SourceItem`` that is part of the natural key, so every pre-rename
        record would fail to resolve and the next poll would mint a duplicate
        of it. Same shape as ``DataSource._adopt_legacy_enabled``.
        """
        return adopt_renamed(data, {"stream_key": "segment_key", "stream_label": "segment_label"})

    def as_example_input(self) -> "tuple[dict, dict]":
        """``(contents, provenance)`` for one dataset example row: this item's
        own envelope as ``input/item.json``, and where it came from. The
        ingest→dataset composition lives with the item, not with ``Dataset``."""
        from flow_sdk.schema.data_spec.layout import INPUT  # noqa: PLC0415

        envelope = SourceItemSpec.model_validate({k: getattr(self, k) for k in SourceItemSpec.model_fields})
        return (
            {f"{INPUT}/item.json": envelope.model_dump(mode="json", exclude_none=True)},
            {
                "data_source_id": self.data_source_id,
                "segment_key": self.segment_key,
                "external_id": self.external_id,
                "item_id": self.id,
            },
        )

    @classmethod
    async def find_existing(cls, data_source_id: str, segment_key: str, external_id: str) -> Optional["SourceItem"]:
        """THE identity lookup — the row for this natural key, or None.

        ``segment_key`` is part of the key because provider ids are frequently
        only unique *within* a segment (a Slack ``ts`` repeats across channels),
        and ``data_source_id`` because the same remote feed added twice must not
        collide. The key itself is declared once, on the type
        (``TypeInfo.natural_key``); this is its named single-row entry point,
        indexed by ``ix_entities_source_item_natural_key_v2``.
        """
        return await cls.serializer().resolve_key(cls, (data_source_id, segment_key, external_id))
