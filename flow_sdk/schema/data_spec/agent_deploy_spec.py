"""An agent's deploy over HTTP (``POST agent/<id>/deploy``): the request."""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, field_validator

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


__all__ = ["AgentDeployRequest"]
