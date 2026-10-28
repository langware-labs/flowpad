"""An agent's deploy over HTTP (``POST agent/<id>/deploy``): the request, and the answer to a cloud deploy
that was taken on and runs on."""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.credential_contract import is_valid_environment
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.token_allocation_spec import TokenAllocationSpec


class AgentDeployRequest(DataSpec):
    """Where to deploy an agent and how. ``provider``: ``local`` is this computer, any other the hub's name for a
    compute provider, empty the hub's default. ``environment``: the credential environment a cloud placement
    reads (empty: ``production``). ``token_allocation``: the placement's own budget — absent leaves it as it is,
    ``null`` releases it. ``wait``: answer only once the machine is placed."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.deploy_request"

    provider: str = ""
    environment: Optional[str] = None
    token_allocation: Optional[TokenAllocationSpec] = None
    wait: bool = False

    @field_validator("provider", mode="before")
    @classmethod
    def _stripped(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("environment", mode="before")
    @classmethod
    def _an_environment(cls, value: Any) -> Optional[str]:
        name = str(value or "").strip()
        if not name:
            return None
        if not is_valid_environment(name):
            raise ValueError(f"{name!r} is not a valid environment name")
        return name

    @property
    def allocation_given(self) -> bool:
        """Whether the request names a token allocation at all — ``null`` (release it) included."""
        return "token_allocation" in self.model_fields_set


class ActivityAddress(DataSpec):
    """Where a run reports: its activity's path on its subject entity — what a screen follows to watch it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "activity.address"

    path: str
    subject_entity: str


class DeployAccepted(DataSpec):
    """A cloud deploy taken on. Its steps report at ``activity`` until the run ends; ``warnings`` name what the
    placement will run without (its model funding), which never stops a deploy."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.deploy_accepted"

    agent_id: str
    activity: ActivityAddress
    warnings: list[str] = Field(default_factory=list)
    #: The placement it lands on — planned now; its machine arrives with the run's end.
    deployment_id: str = ""


__all__ = ["ActivityAddress", "AgentDeployRequest", "DeployAccepted"]
