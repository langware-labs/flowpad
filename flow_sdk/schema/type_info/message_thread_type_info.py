"""Type metadata for MESSAGE_THREAD — one thread of ingested cloud messages.

**Tier B, for the same reasons as SOURCE_ITEM.** No placement fields, so the
indexer's walk can never reach it and the projector can never contend with the
indexer's SQLite writer. Not ``db_only`` either: a thread's ``title`` is a mail
subject, and finding a conversation by subject is the obvious thing to want.

``creatable=False``: a thread is born from an ingested record, with an id
derived from ``(channel, thread_key)``. A hand-POSTed row would get a random
uuid4 that the projector could never converge with — the same permanent-
duplicate hazard SOURCE_ITEM's gate exists to prevent.
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class MessageThreadMeta(BaseMeta):
    # Mirrored to metadata.json for inspection. NOT a recovery path — like
    # every Tier B type this one has no `from_disk_fn`, so nothing reads these
    # files back into the DB.
    channel: Optional[str] = None
    thread_key: Optional[str] = None
    conversation_id: Optional[str] = None
    # The searchable payload. `name` (on BaseMeta) carries the title for FTS;
    # this is the same string kept under its own name for queries.
    title: Optional[str] = None
    message_count: Optional[int] = None


MESSAGE_THREAD = TypeMetadata(
    type=EntityType.MESSAGE_THREAD,
    icon="MessagesSquare",
    api_visible=True,
    creatable=False,
    index_fields=["name", "channel", "conversation_id"],
    meta_model=MessageThreadMeta,
)
