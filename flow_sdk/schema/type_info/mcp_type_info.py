"""Type metadata for MCP — FlowPad's own, authored MCP-server asset.

A flowpad-native REPO folder asset at ``agentic-assets/mcp/<name>/``, found by
the shared ``repo_assets_fn`` walker via ``main_file`` — no bespoke walker, and
nested under an owning asset (an Agent) with no extra wiring, because that
walker already recurses into folder assets.

``name`` lives IN ``mcp.json`` (not ``name_from_path``): the file is the whole
spec, so the document the serializer validates has to carry every required
field. The folder name is a path, not the identity — same as SubAgent.

Identity is a WRITABLE folder capsule, so the id is a v4 minted once and written
into the asset. Nothing here is derived from a path: derivation exists only for
read-only sources we cannot write into, which is the sibling MCP_SERVER scan.
"""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    folder_json_identity,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.mcp_spec import McpSpec
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

MCP = TypeInfo(
    type_name=EntityType.MCP,
    icon="Plug",
    display_name="MCP Servers",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["command", "url", "transport"],
    asset_class="repo",
    family="mcp",
    shape=Folder(main="mcp.json"),
    editor="mcp",
    asset_spec=McpSpec,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_json_identity(),
)
