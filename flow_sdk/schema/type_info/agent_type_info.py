"""Type metadata for AGENT — the launchable agent (identity + launch bundle).

A flowpad-native REPO asset at ``agentic-assets/agent/<name>/agent.md``, found
by the shared ``repo_assets_fn`` walker via ``main_file`` — no bespoke walker.
Distinct from SUBAGENT, which is the provider-owned ``.claude/agents/*.md``.
"""
from flow_sdk.builtin.agent import AgentSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_identity
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

AGENT = TypeInfo(
    type_name=EntityType.AGENT,
    display_name="Agents",
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
    shape=Folder(main="agent.md"),
    editor="agent",
    name_from_path=True,
    fts_content=("system_prompt",),
    identity_carrier=frontmatter_identity(),
    asset_spec=AgentSpec,
    # The entity is the authoring surface for system_prompt, so it re-renders
    # the file on every save rather than writing once.
    owns_main_ref=True,
)
