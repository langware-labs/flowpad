"""What an agent needs to run somewhere, and whether a deployment has it — names only.

An agent's **requirements** ship with it (``agent.json``): the credentials its data sources read, the
permissions they need, and any variable nothing declares — derived from what it owns, plus entries a
person authored. **Readiness** answers one question per requirement: does THIS deployment satisfy it?
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: A credential by name, and the variables of it that are read.
REQUIREMENT_CREDENTIAL = "credential"
#: A ``permission.*`` need.
REQUIREMENT_PERMISSION = "permission"
#: A connection with raw scopes, from a driver that declares no permission for it.
REQUIREMENT_CONNECTION = "connection"
#: A variable read by name that no credential declares.
REQUIREMENT_VARIABLE = "variable"
REQUIREMENT_KINDS = (REQUIREMENT_CREDENTIAL, REQUIREMENT_PERMISSION, REQUIREMENT_CONNECTION, REQUIREMENT_VARIABLE)


class RequirementSpec(DataSpec):
    """One thing an agent needs. ``derived`` ones are recomputed from what the agent owns; authored ones
    are kept as written."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.requirement"

    #: ``credential`` / ``permission`` / ``connection`` / ``variable``.
    kind: str
    #: The credential name, the ``permission.*`` kind, the connection provider or the variable name.
    name: str
    #: The variables read (a credential), or the variable whose value grants an API-key permission.
    vars: list[str] = Field(default_factory=list)
    #: A connection's raw scopes.
    scopes: list[str] = Field(default_factory=list)
    #: The resource a permission is needed on (a bucket, a channel).
    on: str = ""
    why: str = ""
    derived: bool = False
    #: The data sources (by name) that need it.
    used_by: list[str] = Field(default_factory=list)

    @field_validator("kind")
    @classmethod
    def _known(cls, value: str) -> str:
        if value not in REQUIREMENT_KINDS:
            raise ValueError(f"unknown requirement kind {value!r}; expected one of {list(REQUIREMENT_KINDS)}")
        return value

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.kind, self.name, self.on)


class ReadinessItemSpec(DataSpec):
    """One requirement at one deployment."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.readiness.item"

    requirement: RequirementSpec
    #: ``verified`` (checked against the grant), ``declared`` (a value is present, what it allows is not
    #: checkable) or ``missing``.
    status: str
    #: Where it was looked for: a store, a connection.
    where: str = ""
    #: The one step that fixes a missing item.
    fix: str = ""


class ReadinessSpec(DataSpec):
    """Does this deployment satisfy the agent's requirements? Names only."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.readiness"

    agent_id: str
    deployment_id: str
    environment: str
    ready: bool
    items: list[ReadinessItemSpec] = Field(default_factory=list)


__all__ = [
    "REQUIREMENT_CONNECTION",
    "REQUIREMENT_CREDENTIAL",
    "REQUIREMENT_KINDS",
    "REQUIREMENT_PERMISSION",
    "REQUIREMENT_VARIABLE",
    "ReadinessItemSpec",
    "ReadinessSpec",
    "RequirementSpec",
]
