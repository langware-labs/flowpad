"""Type metadata for SPEC."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.spec import (
    extract_spec,
    spec_gen_id,
)

SPEC = TypeMetadata(
    type=EntityType.SPEC,
    from_disk_fn=extract_spec,
    gen_id_fn=spec_gen_id,
    indexed_by_default=True,
    browseable=True,
    icon="FileText",
    api_visible=True,
    index_fields=["name", "spec_type"],
)
