"""``LLMEndpoint`` — the box-side mirror of the hub entity.

An LLM endpoint is a budget you may spend: a ROOT holding a provider credential, or an allocation
drawing on another endpoint through the hub's ``source_llmendpoint`` relationship. The hub owns all
of it — the credential, the limits, the chain, the ledger — and authorizes every ``invoke`` against
the endpoint named in the URL.

This class exists so the box can *hold* one as an entity rather than as a four-field binding record
(``instance_settings.llm_endpoint.HubLLMEndpoint``, which stays: it is what the hub PUSHES). It is a
**read-only projection**:

* instances are built from the hub's own serialization (``fetch_hub_llm_endpoints``) and are not
  persisted locally — the hub is ground truth, and a local row could only ever drift from it;
* there is deliberately no ``sources`` field. Since the hub made allocation a relationship, sources
  are not part of an endpoint's serialization, and mirroring one would be inventing state;
* nothing here writes to the hub. Creating or re-budgeting an endpoint is ``allocate`` on the parent,
  which is authorized against the budget being delegated and has no client-writable equivalent.

``_api_visible`` is False for the same reason: there are no local rows to serve. The list reaches the
UI through the ``llm-endpoint`` box action, beside the binding it already reports.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core.urls.service_urls import urls_service


class LLMLimits(BaseModel):
    """Ceilings on an endpoint; ``None`` = unlimited, ``0`` = no budget. Cost in USD.

    Mirrors the hub field-for-field. Tokens counted against a limit include cache reads, which are
    priced; ``requests_per_minute`` is the one limit the hub enforces per instance rather than
    through the shared ledger, so it is backpressure rather than a fleet-wide quota.
    """

    tokens_total: int | None = None
    tokens_per_day: int | None = None
    tokens_per_week: int | None = None
    tokens_per_month: int | None = None
    cost_usd_total: float | None = None
    cost_usd_per_day: float | None = None
    cost_usd_per_week: float | None = None
    cost_usd_per_month: float | None = None
    requests_per_minute: int | None = None


class LLMFilters(BaseModel):
    """What an endpoint lets through. An allocation may only ever NARROW its source."""

    models_allow: list[str] = Field(default_factory=list)
    models_deny: list[str] = Field(default_factory=list)
    max_tokens_ceiling: int | None = None
    max_input_chars: int | None = None
    temperature_max: float | None = None
    top_p_max: float | None = None
    betas_allow: list[str] | None = None
    streaming: str = "allow"
    paths_allow: list[str] = Field(default_factory=lambda: ["v1/**"])
    aliases: dict[str, str] = Field(default_factory=dict)
    model_map: dict[str, str] = Field(default_factory=dict)


def hub_invoke_path(typeid: Any) -> str:
    """The FULL hub path an endpoint is invoked on, e.g.
    ``/api/v1/graph/llm_endpoint/<id>/invoke``.

    A binding carries the whole path because it is joined onto a bare origin at call time by
    ``hub_llm_endpoint_invoke_url`` -- hence ``build_entity_path`` (api + graph prefix) rather than
    ``build_hub_url``, which returns a path relative to the api base.
    """
    return urls_service.api.build_entity_path(typeid, None, "invoke")


class LLMEndpoint(Entity):
    # No local rows: instances are transient projections of hub state (see the module docstring).
    _api_visible: ClassVar[bool] = False
    _icon: ClassVar[str | None] = "BrainCircuit"

    type: str = APIField(default="llm_endpoint")
    name: str = APIField(default="")
    provider: str = APIField(default="")
    base_url: str = APIField(default="")
    enabled: bool = APIField(default=True)
    filters: LLMFilters = APIField(default_factory=LLMFilters)
    limits: LLMLimits = APIField(default_factory=LLMLimits)
    member_default_limits: LLMLimits = APIField(default_factory=LLMLimits)
    #: ``****last4`` of the provider key, when this endpoint is a root. Never the key itself.
    credential_hint: str = APIField(default="")
    #: True for an endpoint the hub made for a user/team/org rather than one somebody created.
    system_default: bool = APIField(default=False)

    #: What an endpoint IS, as opposed to what every SDK ``Entity`` carries. A dump of the whole
    #: model would bury these under ~30 fields of local plumbing (tab_order, semantic_lock, ...)
    #: that are all defaults on a projection and mean nothing to a picker.
    WIRE_FIELDS: ClassVar[frozenset[str]] = frozenset((
        "id",
        "type",
        "name",
        "provider",
        "base_url",
        "enabled",
        "filters",
        "limits",
        "member_default_limits",
        "credential_hint",
        "system_default",
    ))

    def to_wire(self) -> dict[str, Any]:
        """The endpoint as something choosing between endpoints needs to see it."""
        data = self.model_dump(mode="json", include=self.WIRE_FIELDS)
        data["invoke_path"] = self.invoke_path()
        return data

    def invoke_path(self) -> str:
        return hub_invoke_path(self.typeid)

    @property
    def is_root(self) -> bool:
        """A root carries the credential. Derived from the hint because sources are a hub-side
        relationship the box never sees."""
        return bool(self.credential_hint)
