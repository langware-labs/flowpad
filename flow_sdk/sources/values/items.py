"""What a source hands back: a ``SourceItemSpec`` is an origin plus a typed payload.

A payload is a ``Payload`` subclass — ``FileData`` describes bytes without holding them,
``MessageData`` describes a message, ``RecordData`` a record; a provider adds its own
(``SlackMessageData`` with a ``raw`` field, a record source's ``IssueData``). A concrete item narrows
``data`` to its schema, so ``FileItem.data`` is always a ``FileData``.

``data`` travels tagged with its ``spec_kind``, which is how a page, an event or an RPC
frame restores the right class without a hand-written switch. Items carry no version:
change detection is the application's, over what it observes.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import AwareDatetime, Field

from flow_sdk._compat import StrEnum

from flow_sdk.schema.data_spec.spec import DataSpec, Tagged
from flow_sdk.sources.values.origin import CloudOrigin


class Payload(DataSpec):
    """The base of every ``data`` a source emits.

    ``volatile`` names fields that describe the observation rather than the resource — a
    provider's ``raw`` echo — so the application's change digest leaves them out.
    """

    volatile: ClassVar[frozenset[str]] = frozenset()

    def stable_dump(self) -> dict:
        """The fields a change digest may look at."""
        return self.model_dump(mode="json", exclude=set(self.volatile))


class FileData(Payload):
    """File metadata. No bytes, handles or download URLs: bytes flow through ``open``/``write``."""

    spec_kind: ClassVar[str] = "ingest.file"

    #: Display filename — not a path, not a key.
    name: Optional[str] = None
    #: Placement relative to the source's declared root, with ``/`` separators.
    path: Optional[str] = None
    #: Source-reported media type; never sniffed.
    media_type: Optional[str] = None
    #: Source-reported byte length; zero is empty, ``None`` is unknown.
    size: Optional[int] = Field(default=None, ge=0)


class FileKind(StrEnum):
    """How a file rides a message — what the recipient's app shows. A voice note is not an audio file,
    and an image sent as a ``DOCUMENT`` arrives uncompressed."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    VOICE = "voice"
    DOCUMENT = "document"
    STICKER = "sticker"


class MessageFileData(FileData):
    """A file that rides a message. Inbound, ``origin.key`` is the provider's media handle and ``path``
    is the local copy the runtime staged while the session was open (``None`` until then, or when
    ``fetch_error`` says why it never came). Outbound, the origin is ``local`` and ``path`` is the
    readable file to send."""

    spec_kind: ClassVar[str] = "ingest.file.message"

    as_: FileKind = FileKind.DOCUMENT
    caption: Optional[str] = None
    #: Reported by the provider (WhatsApp); never computed here.
    sha256: Optional[str] = None
    #: Why the bytes could not be copied — the link expired, the file is over the provider's cap.
    fetch_error: Optional[str] = None


class UserProfile(Payload):
    """Who sent or received a message: an identity plus whatever the provider reported.

    ``origin`` is the identity (a Slack user id, an address); the display fields are
    observed, optional, and never guessed.
    """

    spec_kind: ClassVar[str] = "ingest.profile"

    origin: CloudOrigin
    name: Optional[str] = None
    address: Optional[str] = None
    avatar_url: Optional[str] = None


class SourceItemSpec(DataSpec):
    """One resource as observed: its identity and its payload."""

    origin: CloudOrigin
    data: Tagged[DataSpec]


class FileItem(SourceItemSpec):
    data: Tagged[FileData]


class MessageData(Payload):
    """A message in any channel. ``conversation`` is the containing thread or chat;
    ``in_reply_to`` is the directly answered message when the provider says so — neither is
    ever inferred. ``attachments`` are metadata-only files. An empty ``recipients`` means
    none were reported, not that nobody received it."""

    spec_kind: ClassVar[str] = "ingest.message"

    text: Optional[str] = None
    conversation: Optional[CloudOrigin] = None
    sender: Optional[UserProfile] = None
    sent_at: Optional[AwareDatetime] = None
    attachments: tuple[FileItem, ...] = ()
    in_reply_to: Optional[CloudOrigin] = None
    recipients: tuple[UserProfile, ...] = ()


class EmailMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.email"

    subject: Optional[str] = None


class MessageItem(SourceItemSpec):
    data: Tagged[MessageData]


class ReactionMode(StrEnum):
    """What a reaction report says. ``SET``: ``emojis`` is this person's whole set on the target now
    (``()`` = they took it back) — WhatsApp, WAHA and Telegram report state, and a WhatsApp removal
    carries no emoji at all, so only the holder of the previous state can tell what went. ``ADD`` /
    ``REMOVE``: a delta (Slack's ``reaction_added``)."""

    SET = "set"
    ADD = "add"
    REMOVE = "remove"


class ReactionData(Payload):
    """An emoji on a message: a change of state on ``target``, never a message of its own — it is
    not threaded and never wakes a turn. ``emojis`` are unicode; a custom emoji with no unicode
    form travels as ``:name:``."""

    spec_kind: ClassVar[str] = "ingest.message.reaction"

    target: CloudOrigin
    sender: UserProfile
    emojis: tuple[str, ...] = ()
    mode: ReactionMode = ReactionMode.SET
    sent_at: Optional[AwareDatetime] = None


class ReactionItem(SourceItemSpec):
    data: Tagged[ReactionData]


class RecordData(Payload):
    """A record: a row a record source keeps, updated in place (an issue, a ticket, a table row, a
    feed entry). What every record has — a title, a text, a link; a provider narrows it with its own
    fields (``IssueData``). Stored as a ``SourceItem`` and never threaded, unlike ``MessageData``."""

    spec_kind: ClassVar[str] = "ingest.record"

    title: Optional[str] = None
    text: Optional[str] = None
    url: Optional[str] = None


class RecordItem(SourceItemSpec):
    data: Tagged[RecordData]


class FeedItemData(RecordData):
    """One entry of a feed or listing (an RSS item, a Hacker News story). ``author`` is an
    identity when the provider names one; ``byline`` is the display text it printed, which
    may exist without any identity behind it."""

    spec_kind: ClassVar[str] = "ingest.feed.item"

    published_at: Optional[AwareDatetime] = None
    author: Optional[UserProfile] = None
    byline: Optional[str] = None


__all__ = [
    "EmailMessageData",
    "FeedItemData",
    "FileData",
    "FileItem",
    "FileKind",
    "MessageFileData",
    "ReactionData",
    "ReactionItem",
    "ReactionMode",
    "MessageData",
    "MessageItem",
    "Payload",
    "RecordData",
    "RecordItem",
    "SourceItemSpec",
    "UserProfile",
]
