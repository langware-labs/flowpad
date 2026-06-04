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

    # NOTE: Spec's former ``author_id`` projection moved alongside other
    # implicit projections to ``Entity.get_implicit_private_context_entities``.
    # The base now projects ``project_id`` only; ``author_id`` was dropped
    # per "base returns project_id only for now". Override
    # ``get_implicit_private_context_entities`` here and call ``super()`` to
    # bring it back if the UX needs an author chip.
