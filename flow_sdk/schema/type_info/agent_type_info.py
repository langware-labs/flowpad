"""Type metadata for AGENT — the launchable agent (identity + launch bundle).

A flowpad-native REPO asset at ``agentic-assets/agent/<name>/agent.md``, found
by the shared ``repo_assets_fn`` walker via ``main_file`` — no bespoke walker.
Distinct from SUBAGENT, which is the provider-owned ``.claude/agents/*.md``.
"""
from flow_sdk.builtin.agent import AgentSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, frontmatter_identity
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

AGENT = TypeMetadata(
    type=EntityType.AGENT,
    displayName="Agents",
    # Not Bot — that is SUBAGENT's; Brain/BrainCircuit are claude_memory/graph_context.
    icon="BrainCog",
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
    name_from_path=True,
    fts_content=("system_prompt",),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(),
    asset_spec=AgentSpec,
    # The entity is the authoring surface for system_prompt, so it re-renders
    # the file on every save rather than writing once.
    owns_main_ref=True,
)
