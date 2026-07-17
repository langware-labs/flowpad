"""AgenticFlow — a folder-backed flow document (the whiteboard model).

Folder layout::

    ~/.claude/agentic-flows/<name>/
        graph.json      # the flow document (nodes + edges) — semantic truth
        display.json    # canvas layout only (positions/colors/sizes)
        scripts/        # pysdk node files
        runs/           # execution journals (one JSONL per run)

Disk is the source of truth: routing reads ``graph.json`` (via FlowManager's
flow cache), the DB row is an index, and the flow's internal entities
(FlowNode rows, AgenticFlowRun rows) are attached as CHILDREN for record
keeping only — never for routing or layout.

``save()`` on a fresh entity materializes the folder + stub files.
"""
from pathlib import Path
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

# Per-run loop-budget defaults (a flow may override in graph.json later).
DEFAULT_MAX_HOPS = 16
DEFAULT_MAX_PROCESSES = 10
DEFAULT_DEADLINE_S = 600


def flows_home_dir() -> Path:
    """Default location for user-scope flows (the indexer walker scans this)."""
    return Path.home() / ".claude" / "agentic-flows"


class AgenticFlow(Entity):
    type: str = APIField(default=EntityType.AGENTIC_FLOW.value)
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
        from flow_sdk.flow_manager.flow_doc import empty_flow_doc

        slug = (
            "".join(c if c.isalnum() or c in "-_" else "-" for c in (self.name or "flow")).strip("-")
            or "flow"
        )
        folder = Path(self.asset_ref) if self.asset_ref else flows_home_dir() / slug
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "scripts").mkdir(exist_ok=True)
        (folder / "runs").mkdir(exist_ok=True)
        graph = folder / "graph.json"
        if not graph.exists():
            graph.write_text(empty_flow_doc(self.id or "", self.name), encoding="utf-8")
        display = folder / "display.json"
        if not display.exists():
            display.write_text('{"version": 1, "nodes": {}}\n', encoding="utf-8")
        # Pin the entity id in the capsule so the indexer adopts it.
        if self.id:
            capsule = folder / ".flow"
            capsule.mkdir(exist_ok=True)
            id_file = capsule / "id"
            if not id_file.exists():
                id_file.write_text(self.id, encoding="utf-8")
        self.asset_ref = str(folder)
        return folder

    async def save(self, *args, **kwargs):  # type: ignore[override]
        result = await super().save(*args, **kwargs)
        try:
            prev_ref = self.asset_ref
            self.materialize_folder()
            # Second write only when the scaffold just minted the folder path
            # (fresh flow) — steady-state saves stay a single DB write.
            if self.asset_ref != prev_ref:
                await self.update()
        except Exception:
            import logging

            logging.getLogger(__name__).exception("AgenticFlow: folder scaffold failed")
        return result
