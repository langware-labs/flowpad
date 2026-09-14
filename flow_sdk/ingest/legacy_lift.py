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
from email.utils import formataddr, getaddresses
from typing import Any, Optional

from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.sources.values.items import EmailMessageData, FeedItemData, MessageData, Payload, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin

MESSAGE_KIND = "content.message"
EMAIL_KIND = "content.message.email"
CHAT_KIND = "content.message.chat"
FEED_KIND = "content.feed.item"

#: The record kind each payload family is stored under, most specific first.
_KIND_OF: tuple[tuple[type[Payload], str], ...] = (
    (EmailMessageData, EMAIL_KIND),
    (MessageData, CHAT_KIND),
    (FeedItemData, FEED_KIND),
)


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
    email = kind.startswith(EMAIL_KIND)
    people = _text(source, "account_key") or origin.namespace

    def person(address: str, name: Optional[str]) -> UserProfile:
        return UserProfile(
            origin=CloudOrigin(kind=origin.kind, namespace=people, key=address),
            name=name or None,
            address=address if email else None,
        )

    author = _text(item, "author_external_id")
    sender = person(author, _verbatim(item, "author_display")) if author else None
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
        recipients=tuple(person(addr, name) for name, addr in getaddresses(getattr(item, "recipients", None) or ()) if addr),
    )
    if email:
        return EmailMessageData(subject=_verbatim(item, "name"), **fields)
    return MessageData(**fields)


def lift(source: Any, item: Any) -> Any:
    """The envelope with ``origin`` and ``data`` filled. What it already carries is kept."""
    if item.origin is not None and item.data is not None:
        return item
    origin = item.origin or origin_of(source, item)
    return item.model_copy(update={"origin": origin, "data": item.data or data_of(source, item, origin)})


def kind_of(data: Payload) -> str:
    for family, kind in _KIND_OF:
        if isinstance(data, family):
            return kind
    raise TypeError(f"{type(data).__name__} has no record kind; a record source emits a message or feed payload")


def envelope_of(
    item: Any, *, data_source_id: str, provider: str, segment_key: str, segment_label: str = ""
) -> SourceItemSpec:
    """The inverse of ``lift``: a contract item as the flat envelope the ingestor stores.

    ``origin`` and ``data`` ride along, so lifting the result is the identity — the header is
    only the flat, queryable copy of what the payload already says.
    """
    data = item.data
    person = getattr(data, "sender", None) or getattr(data, "author", None)
    when = getattr(data, "sent_at", None) or getattr(data, "published_at", None)
    return SourceItemSpec(
        data_source_id=data_source_id,
        provider=provider,
        kind=kind_of(data),
        segment_key=segment_key,
        segment_label=segment_label,
        external_id=item.origin.key,
        name=getattr(data, "subject", None) or getattr(data, "title", None) or "",
        body=getattr(data, "text", None) or "",
        occurred_at=when.isoformat() if when else None,
        author_external_id=person.origin.key if person else None,
        author_display=(person.name if person else None) or getattr(data, "byline", None),
        permalink=item.origin.url or getattr(data, "url", None),
        thread_key=_key_of(getattr(data, "conversation", None)),
        reply_to_external_id=_key_of(getattr(data, "in_reply_to", None)),
        recipients=[formataddr((p.name or "", p.address or p.origin.key)) for p in getattr(data, "recipients", ())],
        raw=getattr(data, "raw", None),
        origin=item.origin,
        data=data,
    )


def _key_of(origin: Optional[CloudOrigin]) -> Optional[str]:
    return origin.key if origin is not None else None


def _beside(origin: CloudOrigin, key: str) -> Optional[CloudOrigin]:
    """Another resource in the same scope — a thread, a replied-to message."""
    return CloudOrigin(kind=origin.kind, namespace=origin.namespace, key=key) if key else None


def _when(item: Any) -> Optional[datetime]:
    from flow_sdk.utils.serialization import iso_to_utc  # noqa: PLC0415

    value = getattr(item, "occurred_at", None)
    return iso_to_utc(value) if value else None


__all__ = ["CHAT_KIND", "EMAIL_KIND", "FEED_KIND", "MESSAGE_KIND", "data_of", "envelope_of", "kind_of", "lift", "origin_kind_of", "origin_of"]
