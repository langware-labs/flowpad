"""The navigator's answer: open something now (a quick action), or hand the ask to the assistant.

The shapes only; the routing lives in ``flow_sdk.core.navigator``.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal, Optional

from pydantic import PrivateAttr

from flow_sdk.schema.data_spec.spec import DataSpec

Kind = Literal["view", "entity", "file", "url", "webapp", "app"]


class NavigationTarget(DataSpec):
    spec_kind: ClassVar[str] = "navigator.target"

    kind: Kind
    #: A dock address (``credentials/api-keys``, ``hub/token-plan``), a TypeId, a path, a URL,
    #: a port, or an artifact id -- what ``kind`` says.
    value: str


class NavigatorRoute(DataSpec):
    """What to do with a typed request."""

    spec_kind: ClassVar[str] = "navigator.route"

    route: Literal["quick", "agentic"]
    target: Optional[NavigationTarget] = None
    #: ``navigate`` only when the request asked to be TAKEN somewhere; showing is the default.
    verb: Literal["show", "navigate"] = "show"
    confidence: float = 0.0
    #: How it was decided (``rule`` / ``decision``), or why it fell back (``no_endpoint``,
    #: ``unsure``, ``agentic``, a ``DecisionError`` reason).
    reason: str = ""
    latency_ms: float = 0.0
    #: The search matches the decision was offered (run detail, never serialized).
    _offered: list[dict[str, Any]] = PrivateAttr(default_factory=list)

    @property
    def offered(self) -> list[dict[str, Any]]:
        return self._offered
