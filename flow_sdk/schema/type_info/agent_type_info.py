"""Type metadata for AGENT."""
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_id, write_frontmatter
from flow_sdk.fs_store.indexer.functions.agent import (
    extract_agent,
)
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


def _agent_default_body(entity) -> str:
    """Agent .md written to the agent's main_ref on create.

    Mirrors Skill/Workflow/Spec: without a default-body writer, create persists
    the entity + asset_ref but never materializes the backing .md, leaving a
    dangling pointer the editor reports as "file not found". Frontmatter shape
    (name/description) is what ``parse_agent_markdown`` reads back; the body is
    the agent's system prompt.
    """
    name = (getattr(entity, "name", None) or "Untitled Agent").strip()
    desc = (getattr(entity, "description", None) or "").strip()
    prompt = (getattr(entity, "prompt", None) or "").strip()
    return render_entity_frontmatter(entity, {"name": name, "description": desc}) + f"\n\n{prompt}\n"


AGENT = TypeMetadata(
    type=EntityType.AGENT,
    displayName="Agents",
    from_disk_fn=extract_agent,
    id_from_file_fn=frontmatter_id,
    id_write_fn=write_frontmatter,
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    api_visible=True,
    icon="Bot",
    index_fields=["description"],
    asset_class="shared",
    family="agents",
    default_body_fn=_agent_default_body,
)
