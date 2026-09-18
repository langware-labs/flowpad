"""Type metadata for GRAPH_WORKFLOW — folder-backed flow document (whiteboard model)."""
from flow_sdk.assets.identity import (
    folder_json_identity,
)
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.types.graph_workflow import extract_graph_workflow, graph_workflow_asset_hash
from flow_sdk.assets.types.graph_workflow_doc import GraphWorkflowDoc
from flow_sdk.assets.types.scaffolds import render_graph_document, scaffold_graph_workflow
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

GRAPH_WORKFLOW = TypeInfo(
    render_fn=render_graph_document,
    scaffold_fn=scaffold_graph_workflow,
    scaffold_spec=GraphWorkflowDoc,
    type_name=EntityType.GRAPH_WORKFLOW,
    icon="Workflow",
    display_name="Graph Workflows",
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
    shape=Folder(main="graph.json"),
    from_disk_fn=extract_graph_workflow,
    identity_carrier=folder_json_identity(),
    asset_hash_fn=graph_workflow_asset_hash,
)
