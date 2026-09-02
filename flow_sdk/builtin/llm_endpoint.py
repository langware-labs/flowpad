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
* nothing here writes an endpoint to the hub. Creating or re-budgeting one is ``allocate`` on the
  parent, which is authorized against the budget being delegated and has no client-writable
  equivalent. The single exception is :meth:`LLMEndpoint.share`, which writes no endpoint state at
  all -- it invites a person to one that already exists.

``_api_visible`` is False for the same reason: there are no local rows to serve. The list reaches the
UI through the ``llm-endpoint`` box action, beside the binding it already reports.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core.urls.service_urls import urls_service
from flow_sdk.flowpad_types.enums.auth_enums import HubRole


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


#: What sharing a budget confers: spend it, never control it. See ``LLMEndpoint.share``.
SHARE_ROLE = HubRole.READER.value


def endpoint_share_landing_path(endpoint_id: str) -> str:
    """Where the emailed invitation should land: this endpoint's page in the desktop app.

    Built through ``dock_url`` rather than spelled as an f-string, because that module owns the
    dock-address grammar and is pinned to its TS twin by a contract fixture both suites assert.
    A hand-written path would keep working while a viewType or page-segment rename went green
    everywhere else -- and the only symptom would be an emailed invite that 404s.
    """
    from flow_sdk.core.dock_address import PageId, ViewType, dock_url  # noqa: PLC0415

    return dock_url(ViewType.LLM_ENDPOINTS, pointer=endpoint_id, page=PageId.HUB)


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
    #: Read by ``share_action``: there is no local row to fetch, so a share of this type is an
    #: invitation to something that already exists on the hub rather than a push of local state.
    _hub_only: ClassVar[bool] = True
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

    async def share(self, recipients: list[str] | None = None) -> None:
        """Give somebody this budget to spend: one invitation per email address.

        Deliberately NOT ``Entity.share()``. The generic implementation CREATES the entity on the
        hub from a local row, which is meaningless here twice over -- there is no local row (this is
        a projection of hub state), and the endpoint already exists on the hub. So this overrides it
        entirely and never calls ``super()``: the only thing that travels is the invitation.

        ``reader`` is the role, and that is the whole security story of sharing a budget: the hub's
        ``llm_endpoint`` policy gives ``reader`` exactly ``read, invoke, models, chain, usage``. The
        recipient can spend the budget and watch it drain; they cannot raise its limits, replace the
        provider key underneath the owner, allocate themselves an uncapped sibling, or pass it on.
        Anything above ``reader`` would make the cap advisory.

        ``callback_override`` points the emailed link at this endpoint's page in the desktop app.
        Without it the hub falls back to a bare entity URL the app has no route for, and the
        recipient's "one click" lands nowhere.

        One POST per recipient, because the hub's ``MembershipRequest`` carries a single
        ``recipient_email``. Failures are not swallowed: the caller decides what a partial share
        means, and the UI reports per-address outcomes.
        """
        from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        for email in recipients or []:
            # Lowercased, not merely stripped: the hub stores and looks invitations up by exact
            # match, so a mixed-case address is an invitation the recipient never sees.
            if not (address := normalize_email(email)):
                continue
            await hub_post(
                "llm_endpoint",
                {
                    "recipient_email": address,
                    "invitation_targets": [{"typeid": str(self.typeid), "role": SHARE_ROLE}],
                    "callback_override": endpoint_share_landing_path(self.id),
                },
                self.id,
                "members",
            )

    @property
    def is_root(self) -> bool:
        """A root carries the credential. Derived from the hint because sources are a hub-side
        relationship the box never sees."""
        return bool(self.credential_hint)
