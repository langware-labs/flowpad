"""Type metadata for AGENT — the launchable agent (identity + launch bundle).

A flowpad-native REPO asset at ``agentic-assets/agent/<name>/``, found by the shared
``repo_assets_fn`` walker via its main document. It is an ENTITY DOCUMENT: every field lives in
``agent.json`` (``type``, ``id``, ``name``, then the spec's fields) and the system prompt beside it
in ``system_prompt.md``. A folder still carrying the retired ``agent.md`` is reported, not indexed,
until ``migration_2026_09_entity_json_mains`` converts it.
Distinct from SUBAGENT, which is the provider-owned ``.claude/agents/*.md``.
"""
from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.schema_registry import ENTITY_LAYOUT, TypeInfo
from flow_sdk.schema.data_spec.agent_spec import AgentSpec
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
    shape=Folder.entity_json(EntityType.AGENT.value),
    editor="agent",
    name_from_path=True,
    fts_content=("system_prompt",),
    asset_spec=AgentSpec,
    # The entity document: fields in agent.json, the prompt in system_prompt.md, the id in agent.json.
    manifest_layout=ENTITY_LAYOUT,
    retired_mains=("agent.md",),
    # The entity is the authoring surface for its fields, so it re-renders
    # the document on every save rather than writing once.
    owns_main_ref=True,
)
