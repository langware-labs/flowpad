"""Lift the flat ingestion envelope into the contract's value: an origin and a typed payload.

Drivers emit the flat ``SourceItemSpec`` envelope (``provider``, ``segment_key``,
``external_id``, ``name``/``body`` …) until each one becomes a source class. This module is
the ONE place that shape becomes a ``CloudOrigin`` plus a ``Payload``. The ingestor lifts
every page through it, the cutover migration lifts stored rows through it, and the
projection lifts a row that was never migrated — three readers, one rule, so a row lifted on
write and a row lifted on read always agree.

The scope rule: ``kind`` is the source's channel (its provider when no channel is set, the
envelope's provider when there is no source row at all); ``namespace`` is the account the
source reads as and the segment the item came from — ``<account>/<segment>``, or the segment
alone for a source with no account (a feed). A local row id never appears: an origin travels.

Everything here reads attributes, so an envelope, a ``SourceItem`` row and a migration's
plain namespace over a stored blob all lift the same way. No I/O.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from flow_sdk.sources.values.items import EmailMessageData, FeedItemData, MessageData, Payload, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin

MESSAGE_KIND = "content.message"
EMAIL_KIND = "content.message.email"


def _text(obj: Any, name: str) -> str:
    return str(getattr(obj, name, None) or "").strip()


def _verbatim(obj: Any, name: str) -> Optional[str]:
    return getattr(obj, name, None) or None


def origin_kind_of(source: Any, item: Any) -> str:
    return _text(source, "channel") or _text(source, "provider") or _text(item, "provider")


def origin_of(source: Any, item: Any) -> CloudOrigin:
    """The identity of *item* as the contract names it."""
    account, segment = _text(source, "account_key"), _text(item, "segment_key")
    namespace = f"{account}/{segment}" if account and segment else (account or segment)
    return CloudOrigin(kind=origin_kind_of(source, item), namespace=namespace, key=_text(item, "external_id"))


def data_of(source: Any, item: Any, origin: CloudOrigin) -> Payload:
    """The typed payload the envelope's flat fields describe — nothing guessed, nothing added."""
    kind = _text(item, "kind")
    author = _text(item, "author_external_id")
    sender = None
    if author:
        people = CloudOrigin(kind=origin.kind, namespace=_text(source, "account_key") or origin.namespace, key=author)
        sender = UserProfile(origin=people, name=_verbatim(item, "author_display"))
    if not kind.startswith(MESSAGE_KIND):
        return FeedItemData(
            title=_verbatim(item, "name"),
            text=_verbatim(item, "body"),
            url=_verbatim(item, "permalink"),
            published_at=_when(item),
            author=sender,
            byline=_verbatim(item, "author_display"),
        )
    fields = dict(
        text=_verbatim(item, "body"),
        conversation=_beside(origin, _text(item, "thread_key")),
        sender=sender,
        sent_at=_when(item),
        in_reply_to=_beside(origin, _text(item, "reply_to_external_id")),
    )
    if kind.startswith(EMAIL_KIND):
        return EmailMessageData(subject=_verbatim(item, "name"), **fields)
    return MessageData(**fields)


def lift(source: Any, item: Any) -> Any:
    """The envelope with ``origin`` and ``data`` filled. What it already carries is kept."""
    if item.origin is not None and item.data is not None:
        return item
    origin = item.origin or origin_of(source, item)
    return item.model_copy(update={"origin": origin, "data": item.data or data_of(source, item, origin)})


def _beside(origin: CloudOrigin, key: str) -> Optional[CloudOrigin]:
    """Another resource in the same scope — a thread, a replied-to message."""
    return CloudOrigin(kind=origin.kind, namespace=origin.namespace, key=key) if key else None


def _when(item: Any) -> Optional[datetime]:
    from flow_sdk.utils.serialization import iso_to_utc  # noqa: PLC0415

    value = getattr(item, "occurred_at", None)
    return iso_to_utc(value) if value else None


__all__ = ["EMAIL_KIND", "MESSAGE_KIND", "data_of", "lift", "origin_kind_of", "origin_of"]
