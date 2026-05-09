from __future__ import annotations

from typing import ClassVar, List, Optional, Dict, Any

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import TypeId


class SpecType(StrEnum):
    PLAN = "plan"
    ISSUE = "issue"
    SUPPORT_TICKET = "support_ticket"


class Spec(Entity):
    type: str = APIField(default="spec")
    title: str = APIField("")
    content: Optional[str] = APIField(None, blob=True)
    spec_type: str = APIField(SpecType.PLAN)
    author_id: Optional[str] = APIField(None)
    asset_ref: Optional[str] = APIField(None)
    metadata: Optional[Dict[str, Any]] = APIField(None)
    # NOTE: plan_id moved into ``context_entities``. Use
    # ``spec.first_context_of_type('plan')`` to read it back.
    _api_visible: ClassVar[bool] = True

    def _direct_fields_as_typeids(self) -> List[TypeId]:
        out: List[TypeId] = []
        if self.author_id:
            out.append(TypeId(type="user", id=self.author_id))
        return out
