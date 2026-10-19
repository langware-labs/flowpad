"""Type metadata for JOURNEY — folder-backed guided-onboarding document."""
from flow_sdk.assets.identity import (
    folder_json_identity,
)
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.types.graph_workflow_doc import GraphWorkflowDoc
from flow_sdk.assets.types.journey import extract_journey, journey_asset_hash
from flow_sdk.assets.types.scaffolds import render_graph_document, scaffold_journey
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

JOURNEY = TypeInfo(
    render_fn=render_graph_document,
    scaffold_fn=scaffold_journey,
    scaffold_spec=GraphWorkflowDoc,
    type_name=EntityType.JOURNEY,
    icon="Compass",
    display_name="Journeys",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="journey",
    shape=Folder(main="graph.json"),
    editor="journey",
    from_disk_fn=extract_journey,
    identity_carrier=folder_json_identity(),
    asset_hash_fn=journey_asset_hash,
)
