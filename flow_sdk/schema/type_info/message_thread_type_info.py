"""Type metadata for MESSAGE_THREAD — one thread of ingested cloud messages.

**Tier B, for the same reasons as SOURCE_ITEM.** No placement fields, so the
indexer's walk can never reach it and the projector can never contend with the
indexer's SQLite writer. Not ``db_only`` either: a thread's ``title`` is a mail
subject, and finding a conversation by subject is the obvious thing to want.

``creatable=False``: a thread is born from an ingested record and resolved
by its natural key ``(channel, thread_key)`` — a lookup, exactly like
SOURCE_ITEM. A hand-POSTed row would sit beside the projector's row with the
same key and fork the thread, the permanent-duplicate hazard SOURCE_ITEM's
gate exists to prevent.
"""
from typing import Optional

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class MessageThreadMeta(BaseMeta):
    # Mirrored to metadata.json for inspection. NOT a recovery path — like
    # every Tier B type this one has no `from_disk_fn`, so nothing reads these
    # files back into the DB.
    channel: Optional[str] = None
    thread_key: Optional[str] = None
    owner: Optional[str] = None
    conversation_id: Optional[str] = None
    # The searchable payload. `name` (on BaseMeta) carries the title for FTS;
    # this is the same string kept under its own name for queries.
    title: Optional[str] = None
    message_count: Optional[int] = None


MESSAGE_THREAD = TypeInfo(
    type_name=EntityType.MESSAGE_THREAD,
    icon="MessagesSquare",
    api_visible=True,
    creatable=False,
    index_fields=["name", "channel", "thread_key", "owner", "conversation_id"],
    meta_model=MessageThreadMeta,
    # The DB medium's identity: the projector resolves a thread by this key
    # (``DbSerializer.resolve_key``), minting an ordinary uuid4 only on miss.
    natural_key=("channel", "thread_key", "owner"),
)
