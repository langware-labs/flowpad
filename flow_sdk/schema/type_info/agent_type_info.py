"""Type metadata for AGENT — the launchable agent (identity + launch bundle).

A flowpad-native REPO asset at ``agentic-assets/agent/<name>/agent.md``, found
by the shared ``repo_assets_fn`` walker via ``main_file`` — no bespoke walker.
Distinct from SUBAGENT, which is the provider-owned ``.claude/agents/*.md``.
"""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, frontmatter_id
from flow_sdk.fs_store.indexer.functions.agent import agent_default_body, extract_agent
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

AGENT = TypeMetadata(
    type=EntityType.AGENT,
    displayName="Agents",
    icon="Bot",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="repo",
    family="agent",
    main_layout="folder",
    main_file="agent.md",
    # asset_ref IS agent/<name>/agent.md (the walker emits the inner file), so
    # create and rescan agree on the same path.
    main_file_is_asset_ref=True,
    from_disk_fn=extract_agent,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(frontmatter_id),
    default_body_fn=agent_default_body,
    # The entity is the authoring surface for system_prompt, so it re-renders
    # the file on every save rather than writing once.
    owns_main_ref=True,
)
