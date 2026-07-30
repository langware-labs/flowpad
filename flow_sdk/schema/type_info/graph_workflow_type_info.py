"""Type metadata for GRAPH_WORKFLOW — folder-backed flow document (whiteboard model)."""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, folder_capsule_id
from flow_sdk.fs_store.indexer.functions.graph_workflow import (
    graph_workflow_asset_hash,
    graph_workflow_id_from_folder,
    extract_graph_workflow,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

GRAPH_WORKFLOW = TypeMetadata(
    type=EntityType.GRAPH_WORKFLOW,
    icon="Workflow",
    displayName="Graph Workflows",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    # Flowpad-native folder asset, not a harness one: it lives at
    # ``agentic-assets/graph_workflow/<name>/`` and is discovered by the shared
    # ``repo_assets_fn`` walker via ``main_file`` — no bespoke walker.
    asset_class="repo",
    family="graph_workflow",
    main_layout="folder",
    main_file="graph.json",
    from_disk_fn=extract_graph_workflow,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(folder_capsule_id, graph_workflow_id_from_folder),
    asset_hash_fn=graph_workflow_asset_hash,
)
