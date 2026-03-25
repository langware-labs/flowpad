"""ProcessResult entity representing output produced by an AgenticProcess."""

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class ProcessResult(Entity):
    """Generic result metadata produced by an AgenticProcess."""

    type: str = APIField(default=BuiltinEntityType.PROCESS_RESULT.value)
    agentic_process_id: str = APIField(description="AgenticProcess ID that produced this result")
    status: str = APIField(default="running", description="Result status (running, complete, error)")
    result_type: Optional[str] = APIField(default=None, description="Result kind (e.g., analysis)")
    source_session_id: Optional[str] = APIField(default=None, description="Source session id associated with result")
    worker_session_id: Optional[str] = APIField(
        default=None, description="Worker session id for the process generating the result"
    )

    # Note: root_vfs_path is inherited from Entity and stores the result folder path
    _api_visible: ClassVar[bool] = True
