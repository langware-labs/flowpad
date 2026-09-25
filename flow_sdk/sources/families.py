"""The three source families: what a source's items are, and so where the application lands them.

A driver extends exactly one of these (with ``CollectionSource`` beside it when it wants the shared
read path). The family is the payload shape and the destination; what a source can DO (``ByteStore``,
``Mutable``, ``Messaging``…) stays a protocol discovered by ``isinstance``.

* ``ObjectSource`` — files (a folder, a bucket, a drive, a repository). Items are ``FileItem``s; the
  application reflects them onto disk and indexes them as assets. The traits here are the ones only a
  file tree has: where its tree lives, whether its bytes may carry our identity, the handle identity
  survives a rename on.
* ``RecordSource`` — records (a feed, an issue tracker, a table). Items are ``RecordData``; the
  application keeps them as ``SourceItem`` rows, updated in place when their content changes.
* ``MessageSource`` — a record source whose records are ``MessageData`` in conversations (mail, chat,
  a phone line). The application threads them into the stream inbox and answers through the source;
  the traits here are the ones only a channel has.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from flow_sdk.sources.base import Family, Source


class ObjectSource(Source):
    family: ClassVar[Family] = Family.OBJECT

    #: The config key naming the local tree this source reads in place (``root``, ``repo``). Empty when
    #: its bytes are remote and pulled into a cache.
    local_tree_key: ClassVar[str] = ""
    #: The source's bytes are ours to write an identity into.
    stamps_identity: ClassVar[bool] = True

    @classmethod
    def origin_id_for(cls, row: Any, ref: str, root: Any) -> str:
        """The identity reflection resolves an unstamped file at ``ref`` (under ``root``) on — a handle
        that survives a rename. ``""`` means the source-relative path is the best there is."""
        return ""


class RecordSource(Source):
    family: ClassVar[Family] = Family.RECORD


class MessageSource(RecordSource):
    family: ClassVar[Family] = Family.MESSAGE

    #: Strangers are the point of this channel (a help desk): an empty allowlist admits everyone.
    open_inbound: ClassVar[bool] = False
    #: A send comes back as a record of its own (the provider echoes it); ``False`` when what ``send``
    #: returns is the only copy (speech, a local reply).
    echoes_sends: ClassVar[bool] = True
    #: A send may land as a draft instead (nobody on the line, a worker that only drafts).
    sends_may_draft: ClassVar[bool] = False

    @classmethod
    def outbound_spec(cls) -> Optional[type]:
        """The message spec that knows who a reply on this channel is addressed to; ``None`` means email's."""
        return None

    @classmethod
    def permalink(cls, external_id: str, thread_key: str = "") -> str:
        """A link into the channel's own UI for a record the provider gave no URL — a formula, never
        a fetch, because the link is digested. ``""`` when the channel cannot be addressed."""
        return ""


__all__ = ["MessageSource", "ObjectSource", "RecordSource"]
