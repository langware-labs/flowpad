"""Type metadata for CLAUDE_HOOK."""
import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.claude_hook import (
    claude_hook_identity_key,
    extract_claude_hook,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CLAUDE_HOOK = TypeMetadata(
    type=EntityType.CLAUDE_HOOK,
    icon="Webhook",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_claude_hook,
    main_ext=".json",  # a derived file type states the format it reads; the ".md" default was a lie here
    identity_carrier=derived_identity(),
    id_stable_key_fn=claude_hook_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
