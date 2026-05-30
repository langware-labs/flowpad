"""Type metadata for AGENT."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.agent import (
    agent_gen_id,
    extract_agent,
)

AGENT = TypeMetadata(
    type=EntityType.AGENT,
    from_disk_fn=extract_agent,
    gen_id_fn=agent_gen_id,
    indexed_by_default=True,
    browseable=True,
    creatable=True,
    api_visible=True,
    icon="Bot",
    index_fields=["description"],
    main_subdir=".claude/agents",
)
