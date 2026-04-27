from __future__ import annotations

from typing import ClassVar, Optional, Dict, Any

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class SpecType(StrEnum):
    PLAN = "plan"
    ISSUE = "issue"
    SUPPORT_TICKET = "support_ticket"


class Spec(Entity):
    type: str = APIField(default="spec")
    title: str = APIField("")
    content: Optional[str] = APIField(None, blob=True)
    spec_type: str = APIField(SpecType.PLAN)
    plan_id: Optional[str] = APIField(None)
    author_id: Optional[str] = APIField(None)
    asset_ref: Optional[str] = APIField(None)
    metadata: Optional[Dict[str, Any]] = APIField(None)
    _api_visible: ClassVar[bool] = True
