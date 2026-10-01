"""Health: how a service says it is alive, and what a check found.

Every ``ServiceEndpoint`` has a ``health_check()``; a ``ComputeNode``'s ``health_check()`` is the list
of all its services'. The CHECK is declared (:data:`HealthCheck`), or defaulted from the endpoint's
protocol and backend; the RESULT is a value (:class:`EndpointHealth`, :class:`NodeHealth`) recorded on
the endpoint as it last was.

Three ways to check, one per kind of service:

* ``http`` — a GET on the service's loopback port answers 2xx/3xx. A web app, an MCP server, the box's
  FlowPad app.
* ``command`` — a shell command on the machine exits 0. Anything that is not HTTP (``pg_isready``).
* ``builtin`` — the endpoint's own backend knows: a static root exists; a message channel's answering
  loop holds its lock.

The wire form matches the hub's mirror (``flowpad/hub/types/health.py``) byte for byte.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, ClassVar, Literal, Optional, Union

from pydantic import ConfigDict, Field

from flow_sdk._compat import UTC
from flow_sdk.schema.data_spec.spec import DataSpec

HealthState = Literal["alive", "failing", "starting", "unknown"]

#: Worst first: a node or a deployment is as healthy as its least healthy service.
STATE_ORDER: tuple[HealthState, ...] = ("failing", "unknown", "starting", "alive")


class HttpCheck(DataSpec):
    """Alive when a GET on ``path`` at the service's loopback port answers below 400."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["http"] = "http"
    path: str = "/"


class CommandCheck(DataSpec):
    """Alive when ``cmd`` exits 0 on the machine the service runs on."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["command"] = "command"
    cmd: str


class BuiltinCheck(DataSpec):
    """The backend knows: a static root exists; a channel's answering loop is running."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["builtin"] = "builtin"


HealthCheck = Annotated[Union[HttpCheck, CommandCheck, BuiltinCheck], Field(discriminator="type")]


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class EndpointHealth(DataSpec):
    """What one check of one service found."""

    spec_kind: ClassVar[str] = "health.endpoint"
    model_config = ConfigDict(extra="forbid", frozen=True)

    endpoint_id: str
    name: str
    state: HealthState
    observed_at: str = Field(default_factory=now_iso)
    detail: str = ""
    latency_ms: Optional[int] = None


class NodeHealth(DataSpec):
    """Every service on one machine, checked together."""

    spec_kind: ClassVar[str] = "health.node"
    model_config = ConfigDict(extra="forbid", frozen=True)

    node_id: str
    observed_at: str = Field(default_factory=now_iso)
    endpoints: list[EndpointHealth] = Field(default_factory=list)

    @property
    def state(self) -> HealthState:
        return worst(e.state for e in self.endpoints)


def worst(states) -> HealthState:
    """The least healthy of ``states``; ``unknown`` when there are none."""
    seen = set(states)
    for state in STATE_ORDER:
        if state in seen:
            return state
    return "unknown"


__all__ = [
    "BuiltinCheck",
    "CommandCheck",
    "EndpointHealth",
    "HealthCheck",
    "HealthState",
    "HttpCheck",
    "NodeHealth",
    "STATE_ORDER",
    "now_iso",
    "worst",
]
