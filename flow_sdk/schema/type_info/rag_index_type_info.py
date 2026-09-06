"""Type metadata for RAG_INDEX.

**Tier B**, like ``DataSource``: no placement fields, so the indexer can never walk it, but not
``db_only`` either — a configured index should be findable in search, and its shadow is a
forensic trail of what was covered and with which model.

Deliberately not ``browseable_by``: an index is operated with verbs (add a folder, index, query,
clear) that a generic type browser has nowhere to put. Its own surface owns those.
"""

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

RAG_INDEX = TypeInfo(
    type_name=EntityType.RAG_INDEX,
    icon="Brain",
    display_name="RAG indexes",
    api_visible=True,
    creatable=True,
    index_fields=["name", "status"],
)
