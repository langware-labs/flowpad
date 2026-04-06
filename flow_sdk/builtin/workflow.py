from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

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
    source_vfs_path: str | None = APIField(
        default=None, description="VFS path to the workflow file (e.g., workflows/<uuid>/main.md)"
    )
    project_id: str | None = APIField(default=None, description="ID of the parent project")
    tab_index: int | None = APIField(
        default=None, description="Tab index for UI display. null = not in tabs. 0 = first position."
    )
    prepared_vfs_path: str | None = APIField(
        default=None, description="VFS path to the prepared file (e.g., workflows/name.prepared.md)"
    )
    pipeline_vfs_path: str | None = APIField(
        default=None, description="VFS path to the generated pipeline.json"
    )
    _api_visible: ClassVar[bool] = True

    async def run(self) -> "AgenticProcess":
        """Execute the workflow by running its source content as an agentic process.

        Reads source_vfs_path and runs it via AgenticProcess.
        No HTTP API calls — uses the Claude CLI directly.

        Returns:
            AgenticProcess. Use process.output_folder or process.outputs
            to access files written by Claude.
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.flowpad_types.enums import WorkerType

        if not self.source_vfs_path:
            raise ValueError("No source file linked to this workflow")

        abs_path = Path("/" + self.source_vfs_path.lstrip("/"))
        if not abs_path.exists():
            raise FileNotFoundError(f"Workflow file not found: {abs_path}")

        content = abs_path.read_text(encoding="utf-8")

        process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
        await process.prompt(content)
        return process

    @action.post(action_name="prepare")
    async def prepare(self) -> ApiSuccessResponse | ApiFailResponse:
        """Parse the workflow markdown into a Pipeline JSON and write it to VFS.

        Reads source_vfs_path, runs the AMD parser, writes pipeline.json next to
        the markdown file, and saves pipeline_vfs_path on this entity.
        """
        from flow_sdk.pipeline.amd_parser import parse_amd_to_pipeline

        if not self.source_vfs_path:
            return ApiFailResponse(message="No source file linked to this workflow")

        # Resolve to absolute path.
        # source_vfs_path is stored as a path relative to "/" (the local machine mount).
        # e.g. "Users/alice/projects/workflows/example.md" → /Users/alice/projects/workflows/example.md
        abs_source = Path("/" + self.source_vfs_path.lstrip("/"))

        if not abs_source.exists():
            return ApiFailResponse(message=f"Workflow file not found: {abs_source}")

        markdown = abs_source.read_text(encoding="utf-8")

        # Parse AMD → Pipeline
        pipeline = parse_amd_to_pipeline(markdown, self.id)
        pipeline_json = pipeline.model_dump_json(indent=2, exclude_none=True)

        # Write pipeline.json next to the markdown file (replace .md suffix)
        abs_pipeline = Path(re.sub(r"\.md$", ".pipeline.json", str(abs_source)))
        abs_pipeline.write_text(pipeline_json, encoding="utf-8")

        # Derive VFS path (strip leading "/")
        pipeline_vfs_path = str(abs_pipeline).lstrip("/")

        self.pipeline_vfs_path = pipeline_vfs_path
        await self.save()

        return ApiSuccessResponse(data={"pipeline_vfs_path": pipeline_vfs_path})
