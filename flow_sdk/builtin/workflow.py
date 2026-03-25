from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


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
    _api_visible: ClassVar[bool] = True
