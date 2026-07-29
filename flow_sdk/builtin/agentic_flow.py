"""AgenticFlow — a folder-backed flow document (the whiteboard model).

Folder layout::

    ~/agentic-assets/agentic_flow/<name>/
        graph.json      # the flow document (nodes + edges) — semantic truth
        display.json    # canvas layout only (positions/colors/sizes)
        scripts/        # function node scripts
        runs/           # execution journals (one JSONL per run)

Disk is the source of truth: routing reads ``graph.json`` (via FlowManager's
flow cache), the DB row is an index, and the flow's internal entities
(FlowNode rows, AgenticFlowRun rows) are attached as CHILDREN for record
keeping only — never for routing or layout.

``save()`` on a fresh entity materializes the folder + stub files.
"""
from pathlib import Path
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

def flows_home_dir() -> Path:
    """Default location for user-scope flows (the indexer walker scans this)."""
    return Path.home() / ".claude" / "agentic-flows"


class AgenticFlow(Entity):
    type: str = APIField(default=EntityType.AGENTIC_FLOW.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    enabled: bool = APIField(default=True, description="The flow's active switch.")

    _api_visible: ClassVar[bool] = True

    @property
    def folder(self) -> Optional[Path]:
        return Path(self.asset_ref) if self.asset_ref else None

    def materialize_folder(self) -> Path:
        """Create the folder + stub files for a fresh flow (idempotent)."""
        from flow_sdk.builtin.flow_folder import scaffold_flow_folder

        return scaffold_flow_folder(self, flows_home_dir(), "flow", scripts=True)

    async def save(self, *args, **kwargs):  # type: ignore[override]
        result = await super().save(*args, **kwargs)
        from flow_sdk.builtin.flow_folder import rescaffold_after_save

        await rescaffold_after_save(self, "AgenticFlow")
        return result
