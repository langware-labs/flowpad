from typing import Any, ClassVar, Dict, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Annotation(Entity):
    type: str = APIField(default="annotation")
    labels: list[str] = APIField(default_factory=list)
    target_type: str = APIField("")
    target_id: str = APIField("")
    content: str = APIField("")      # max 50 chars
    session_id: str = APIField("")   # Claude session ID (worker_session_id)
    iso_timestamp: str = APIField("")
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)  # PTY: seq, seqOffset, line
    _api_visible: ClassVar[bool] = True
