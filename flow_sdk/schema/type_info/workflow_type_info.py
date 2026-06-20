"""Type metadata for WORKFLOW."""
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.workflow import (
    extract_workflow,
    workflow_gen_id,
)

def _workflow_default_body(entity) -> str:
    """AMD source written to the workflow's asset_ref on create.

    Mirrors Skill/Agent: without a default-body writer, create persists the
    entity + asset_ref but never materializes the backing .md, leaving a
    dangling pointer the editor reports as "File is missing".
    """
    title = (getattr(entity, "name", None) or "Untitled Workflow").strip()
    desc = (getattr(entity, "description", None) or "").strip()
    return render_entity_frontmatter(entity, {"name": title}) + f"\n\n# {title}\n\n{desc}\n"


WORKFLOW = TypeMetadata(
    type=EntityType.WORKFLOW,
    icon="Workflow",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name", "description"],
    main_subdir=".claude/workflows",
    from_disk_fn=extract_workflow,
    gen_id_fn=workflow_gen_id,
    default_body_fn=_workflow_default_body,
)
