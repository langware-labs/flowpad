"""Type metadata for AGENTIC_FLOW — folder-backed flow document (whiteboard model)."""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, folder_capsule_id
from flow_sdk.fs_store.indexer.functions.agentic_flow import (
    agentic_flow_asset_hash,
    agentic_flow_id_from_folder,
    extract_agentic_flow,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

AGENTIC_FLOW = TypeMetadata(
    type=EntityType.AGENTIC_FLOW,
    icon="Workflow",
    displayName="Agentic Flows",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="harness",
    harness="claude",
    family="agentic-flows",
    main_layout="folder",
    main_file="graph.json",
    from_disk_fn=extract_agentic_flow,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(folder_capsule_id, agentic_flow_id_from_folder),
    asset_hash_fn=agentic_flow_asset_hash,
)
