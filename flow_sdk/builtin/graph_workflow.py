"""GraphWorkflow — a folder-backed flow document (the whiteboard model).

Folder layout::

    <user_home>/agentic-assets/graph_workflow/<name>/
        graph.json      # the flow document (nodes + edges) — semantic truth
        display.json    # canvas layout only (positions/colors/sizes)
        scripts/        # function node scripts
        runs/           # execution journals (one JSONL per run)

Disk is the source of truth: routing reads ``graph.json`` (via GraphWorkflowManager's
flow cache), the DB row is an index, and the flow's internal entities
(GraphWorkflowNode rows, GraphWorkflowRun rows) are attached as CHILDREN for record
keeping only — never for routing or layout.

``save()`` on a fresh entity materializes the folder + stub files.
"""
from pathlib import Path
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

def graph_workflows_home_dir() -> Path:
    """Default location for user-scope graph workflows.

    Delegates to the placement resolver rather than hand-rolling a path, so this
    stays in lockstep with the type's ``asset_class``/``family`` — a REPO asset
    lands at ``<user_home>/agentic-assets/graph_workflow/``, which is exactly
    where the shared ``repo_assets_fn`` walker looks.
    """
    from flow_sdk.fs_store.placement import Scope, resolve_destination
    from flow_sdk.instance_settings import get_instance_settings

    dest = resolve_destination(
        EntityType.GRAPH_WORKFLOW.value, Scope.USER, default_worker="claude"
    )
    if dest is None:  # pragma: no cover — REPO types always resolve a user scope
        return get_instance_settings().user_home / "agentic-assets" / "graph_workflow"
    return dest


class GraphWorkflow(Entity):
    type: str = APIField(default=EntityType.GRAPH_WORKFLOW.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="")
    enabled: bool = APIField(default=True, description="The flow's active switch.")

    _api_visible: ClassVar[bool] = True

    @property
    def folder(self) -> Optional[Path]:
        return Path(self.asset_ref) if self.asset_ref else None

    def materialize_folder(self) -> Path:
        """Create the folder + stub files for a fresh flow (idempotent)."""
        from flow_sdk.builtin.graph_workflow_folder import scaffold_graph_workflow_folder

        return scaffold_graph_workflow_folder(self, graph_workflows_home_dir(), "flow", scripts=True)

    async def save(self, *args, **kwargs):  # type: ignore[override]
        result = await super().save(*args, **kwargs)
        from flow_sdk.builtin.graph_workflow_folder import rescaffold_after_save

        await rescaffold_after_save(self, "GraphWorkflow")
        return result
