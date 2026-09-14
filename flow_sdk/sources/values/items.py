"""What a source hands back: a ``SourceItemSpec`` is an origin plus a typed payload.

A payload is a ``Payload`` subclass — ``FileData`` describes bytes without holding them,
``MessageData`` describes a message, a provider adds its own (``SlackMessageData`` with a
``raw`` field) or a record source declares one (``IssueData``). A concrete item narrows
``data`` to its schema, so ``FileItem.data`` is always a ``FileData``.

``data`` travels tagged with its ``spec_kind``, which is how a page, an event or an RPC
frame restores the right class without a hand-written switch. Items carry no version:
change detection is the application's, over what it observes.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import AwareDatetime, Field

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


__all__ = [
    "EmailMessageData",
    "FileData",
    "FileItem",
    "MessageData",
    "MessageItem",
    "Payload",
    "SourceItemSpec",
    "UserProfile",
]
