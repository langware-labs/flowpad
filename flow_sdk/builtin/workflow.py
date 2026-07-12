from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess


class WorkflowReportEntry(BaseModel):
    """Schema for one line in ``<output_folder>/workflow.trace.jsonl``.

    The CLI ``flow workflow report --data '<json>'`` validates the agent's
    payload against this model before appending.
    """

    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    kind: Literal["step", "condition", "call", "return"] = "step"
    file: str
    line: int
    status: Literal["enter", "done", "error", "skip", "true", "false"]
    detail: Optional[str] = None
    label: Optional[str] = None
    target: Optional[str] = None

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def _check_kind_status(self) -> "WorkflowReportEntry":
        if self.kind == "step" and self.status not in {"enter", "done", "error", "skip"}:
            raise ValueError(
                f"kind=step requires status ∈ enter|done|error|skip, got {self.status!r}"
            )
        if self.kind == "condition":
            if self.status not in {"true", "false"}:
                raise ValueError("kind=condition requires status ∈ true|false")
            if not self.label:
                raise ValueError("kind=condition requires label")
        if self.kind in ("call", "return") and not self.target:
            raise ValueError(f"kind={self.kind} requires target")
        return self


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

        # worker_type is snake_case on the model; the previous camelCase kwarg
        # was silently dropped by Pydantic, leaving the field as None.
        # Default name so the worker reads meaningfully in the footer process list
        # / tab chip (a workflow runner has no session subject to auto-title from).
        workflow_label = (self.name or "").strip() or abs_path.stem
        process = AgenticProcess(
            worker_type=WorkerType.CLAUDE_CODE, name=f"Workflow: {workflow_label}"
        )
        # save() creates the AgenticProcessRecord on disk so the record-derived
        # execution folders resolve. The entity-side fields are plain APIFields
        # with default=None; meta_dict injects them at serialization but direct
        # attribute access (process.output_folder) reads the field default. Stamp
        # them onto the entity here so callers see the canonical paths without
        # going through .to_dict().
        await process.save()
        # Stamp execution folders from the canonical on-disk layout.
        from flow_sdk.fs_store.fs_record import record_stem
        from flow_sdk.fs_store.record_paths import get_default_records_root
        from flow_sdk.fs_store.fs_ref import FSRef

        base = get_default_records_root() / "agentic_process" / record_stem("agentic_process", process.id)
        folder_map = {
            "exe_folder": base / "execution",
            "input_folder": base / "execution" / "input",
            "output_folder": base / "execution" / "output",
            "assets_folder": base / "execution" / "assets",
        }
        for attr, p in folder_map.items():
            p.mkdir(parents=True, exist_ok=True)
            setattr(process, attr, FSRef(p))
        await process.prompt(content)
        return process

