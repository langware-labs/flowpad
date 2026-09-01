"""Type metadata for COMMAND."""
import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, frontmatter_identity
from flow_sdk.fs_store.indexer.functions.claude_command import (
    command_identity_key,
    extract_claude_command,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

COMMAND = TypeMetadata(
    type=EntityType.COMMAND,
    icon="Terminal",
    indexed_by_default=True,
    api_visible=True,
    asset_class="harness",
    harness="claude",
    family="commands",
    from_disk_fn=extract_claude_command,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=command_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
