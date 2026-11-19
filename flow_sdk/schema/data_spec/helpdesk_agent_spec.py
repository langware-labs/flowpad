"""A help desk's optional agent, as the desk's own page sets it up and lists it."""

from __future__ import annotations

from enum import Enum
from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.spec import DataSpec


class HelpdeskAgentSide(str, Enum):
    """Which side of a ticket the agent writes on."""

    #: Makes sure the team has everything it needs from the customer.
    CUSTOMER = "customer"
    #: Writes a first root-cause analysis for a team member to review; never reaches the customer.
    TEAM = "team"


class HelpdeskAgent(DataSpec):
    """One agent on a desk: who it is, which side it works, and when it replies."""

    spec_kind: ClassVar[str] = "helpdesk.agent"

    desk_project_id: str
    side: HelpdeskAgentSide
    #: What it does, in the owner's words; empty takes the side's default.
    instructions: str = ""
    #: Set once it exists.
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
