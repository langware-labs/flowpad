from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess


class Workflow(Entity):
    """
    Workflow entity - Represents an agentic workflow execution.

    Workflows are AMD (Agentic Markdown) documents that define automated tasks.
    Each workflow is stored as a main.md file in the project's workflows directory.

    Path structure: <project>/workflows/<workflow_id>/main.md
    """

    type: str = APIField(default=BuiltinEntityType.WORKFLOW.value)
    name: str | None = APIField(default=None, description="Display name of the workflow")
    description: str | None = APIField(default=None, description="Description of the workflow")
    asset_ref: str | None = APIField(
        default=None, description="VFS path to the workflow file (e.g., workflows/<uuid>/main.md)"
    )
    tab_index: int | None = APIField(
        default=None, description="Tab index for UI display. null = not in tabs. 0 = first position."
    )
    _api_visible: ClassVar[bool] = True

    async def run(self) -> "AgenticProcess":
        """Execute the workflow by running its source content as an agentic process.

        Reads asset_ref and runs it via AgenticProcess.
        No HTTP API calls — uses the Claude CLI directly.

        Returns:
            AgenticProcess. Use process.output_folder or process.outputs
            to access files written by Claude.
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.flowpad_types.enums import WorkerType

        if not self.asset_ref:
            raise ValueError("No source file linked to this workflow")

        abs_path = Path("/" + self.asset_ref.lstrip("/"))
        if not abs_path.exists():
            raise FileNotFoundError(f"Workflow file not found: {abs_path}")

        content = abs_path.read_text(encoding="utf-8")

        process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
        await process.prompt(content)
        return process
