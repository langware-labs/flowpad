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

from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, Field, PrivateAttr, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.urls.service_urls import urls_service
from flow_sdk.flowpad_types.enums.auth_enums import HubRole

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.client import LLMClient, ProbeResult


class LLMEndpointKind(StrEnum):
    """Where an endpoint's tokens come from — the one axis every funding source differs on.

    Not a ``remote``/``local`` boolean: a boolean can say two of these three things, and the
    interesting question is never "is it remote" but "who is being billed and who holds the
    credential". Same lesson as ``DataSource.status``, which stopped being a boolean for the
    same reason.
    """

    #: A hub ``LLMEndpoint``: a budget, spent with this box's hub login key. The hub holds the
    #: provider credential, resolves the chain and books the usage. A read-only projection here.
    HUB = "hub"
    #: A provider key the user stored on this machine (``secret_name`` in the sod store). The
    #: only kind with a local row.
    API_KEY = "api_key"
    #: A vendor CLI's own OAuth session. Per harness, state on ``Capability``, never persisted
    #: here and never callable in-process — those are credentials for a terminal, not an API.
    DEVICE = "device"


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

#: The sod-store prefix every stored provider key lives under. Mirrors
#: ``cli.auth.lm_api_keys._PREFIX``; kept here so the entity can name its own secret without
#: importing the CLI auth module at class-definition time.
LM_SECRET_PREFIX = "lm_api."


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

    #: Which of the three funding kinds this is. Defaults to HUB so every existing projection
    #: keeps its meaning; ``fetch_hub_llm_endpoints`` forces it, and the before-validator below
    #: promotes a locally-constructed ``LLMEndpoint(provider=...)`` to API_KEY.
    kind: LLMEndpointKind = APIField(default=LLMEndpointKind.HUB)
    #: API_KEY only: the sod store name holding the key (``lm_api.<provider>``). A NAME, never a
    #: value — the key itself never touches a row, a wire payload or a share bundle.
    secret_name: str = APIField(default="", sharing=Sharing.PRIVATE)
    #: ``{sm, md, lg, embedding}`` model slugs for this credential. Per-credential, not
    #: per-harness: the same map serves a spawned worker and an in-process call.
    models: dict[str, str] = APIField(default_factory=dict, sharing=Sharing.PRIVATE)
    #: DEVICE only: which harness's login this projects. Runtime-only — device rows are derived
    #: from ``Capability`` on every read and never stored.
    harness: str = APIField(default="", persist=Persist.FALSE)
    #: Whether the backend itself can call this endpoint. False for DEVICE.
    invocable: bool = APIField(default=True, persist=Persist.FALSE)

    #: An explicit key handed to the constructor. A PrivateAttr, so it is never a field, never
    #: dumped, never persisted and never shared — it exists for ``LLMEndpoint(provider=...,
    #: api_key=...)`` in a script or a test.
    _explicit_api_key: str | None = PrivateAttr(default=None)

    def __init__(self, **data: Any) -> None:
        api_key = data.pop("api_key", None)
        super().__init__(**data)
        if api_key:
            self._explicit_api_key = str(api_key)

    @model_validator(mode="before")
    @classmethod
    def _infer_local_kind(cls, data: Any) -> Any:
        """A named provider with no hub identity is a local key endpoint.

        The ergonomic form the SDK promises is ``LLMEndpoint(provider="openrouter")`` —
        constructible with no database, funded from the environment. A hub projection always
        arrives with the ``id`` of a row that exists on the hub, so requiring one here separates
        the two without a magic flag. An explicit ``kind`` always wins.
        """
        if isinstance(data, dict) and not data.get("kind") and data.get("provider") and not data.get("id"):
            data = {**data, "kind": LLMEndpointKind.API_KEY}
        return data

    @model_validator(mode="after")
    def _fill_local_defaults(self) -> "LLMEndpoint":
        """Give a local key endpoint its provider's base URL, secret name and model slugs.

        Gated on ``API_KEY`` **and** an empty field, so hydrating a stored row or a hub
        projection can never have a default painted over a value that was read from disk.
        """
        if self.kind != LLMEndpointKind.API_KEY or not self.provider:
            return self
        from flow_sdk.external_apis.llm.dialects import get_dialect  # noqa: PLC0415

        try:
            dialect = get_dialect(self.provider)
        except ValueError:
            return self
        if not self.base_url:
            self.base_url = dialect.default_base_url
        if not self.secret_name:
            self.secret_name = f"{LM_SECRET_PREFIX}{self.provider}"
        if not self.models:
            self.models = dict(dialect.default_models)
        if not self.name:
            self.name = f"{self.provider} key"
        return self

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
        # Listed explicitly: ``invocable`` is Persist.FALSE, and a picker that cannot see it
        # would offer the user a device endpoint the backend can never call.
        "kind",
        "secret_name",
        "models",
        "harness",
        "invocable",
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

        if self.kind != LLMEndpointKind.HUB:
            raise ValueError(f"an {self.kind} endpoint is local to this machine and cannot be shared")

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

    # ── credentials and the client ──────────────────────────────────────────

    def resolve_api_key(self, *, allow_environment: bool = True) -> str | None:
        """The key that pays for a call through this endpoint, or ``None``.

        Four sources, most specific first: an explicit constructor argument, the sod store
        entry this row names, the provider's environment variable, and the process config.
        The last two are what make ``LLMEndpoint(provider="openrouter")`` usable in a script
        with nothing stored.

        **``allow_environment=False`` stops at the stored secret**, and that is what the
        funding resolver and every worker spawn ask for. An environment variable is a
        convenience for code running in this process; it is not a choice the user made about
        which credential this box spends. Letting it count would make the picker report a key
        the user never stored, and let it outrank a hub budget they did configure.

        A HUB endpoint's key is the hub login key — the hub swaps in the real provider
        credential on the far side. A DEVICE endpoint has no key at all, by definition.
        """
        if self.kind == LLMEndpointKind.DEVICE:
            return None
        if self.kind == LLMEndpointKind.HUB:
            from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415

            return resolve_hub_api_key()
        if self._explicit_api_key:
            return self._explicit_api_key
        if self.secret_name:
            from flow_sdk.cli.auth.secrets import read_secret  # noqa: PLC0415

            try:
                stored = read_secret(self.secret_name)
            except Exception:  # noqa: BLE001 -- a locked or absent store is "no key", not a crash
                stored = None
            if stored:
                return stored
        return self._key_from_environment() if allow_environment else None

    def _key_from_environment(self) -> str | None:
        import os  # noqa: PLC0415

        from flow_sdk.external_apis.llm.dialects import get_dialect  # noqa: PLC0415

        try:
            dialect = get_dialect(self.provider)
        except ValueError:
            return None
        if dialect.env_var and os.environ.get(dialect.env_var):
            return os.environ[dialect.env_var]
        if dialect.config_attr:
            from flow_sdk.config import default_service_config  # noqa: PLC0415

            return getattr(default_service_config, dialect.config_attr, None)
        return None

    def client(self) -> "LLMClient":
        """A ready-to-call client for this endpoint.

        The provider dialect decides the wire protocol and the auth header shape. For a HUB
        endpoint that dialect is the *root's* — the hub relays verbatim, so what it speaks
        upstream is what the caller must speak to it — with the base URL pointed at the hub's
        invoke path instead of the vendor.
        """
        from flow_sdk.external_apis.llm.client import LLMClient  # noqa: PLC0415
        from flow_sdk.external_apis.llm.errors import LLMNotInvocable  # noqa: PLC0415

        if self.kind == LLMEndpointKind.DEVICE:
            raise LLMNotInvocable(
                f"{self.name or self.harness} is a vendor device login; it can fund a CLI worker "
                f"but the backend cannot call it"
            )
        models = dict(self.models)
        if self.kind == LLMEndpointKind.HUB:
            base_url = self._hub_invoke_url()
            if not base_url:
                raise LLMNotInvocable(f"{self.name or self.id} is not reachable: this box has no hub origin")
            # No referer/title headers on the hub hop: the bearer is the hub login key and the
            # hub adds the root's own auth on the far side.
            return LLMClient.for_dialect(
                self.provider or "openrouter",
                api_key=self.resolve_api_key(),
                base_url=base_url,
                # ``or None`` so an empty map falls back to the ROOT provider's slugs. The hub
                # serializes no model names, so a hub endpoint carries none of its own, and
                # without this every hub call had to name a model explicitly — which the docs
                # said it did not.
                models=models or None,
                extra_headers={},
                label=self.name or "hub endpoint",
            )
        return LLMClient.for_dialect(
            self.provider,
            api_key=self.resolve_api_key(),
            base_url=self.base_url,
            models=models or None,
            label=self.name or self.provider,
        )

    def _hub_invoke_url(self) -> str:
        from flow_sdk.instance_settings.llm_endpoint import hub_origin  # noqa: PLC0415

        origin = hub_origin()
        return f"{origin}{self.invoke_path()}" if origin else ""

    async def create_completion(self, system: str, user: str, **kwargs: Any) -> Any:
        """One chat turn through this endpoint. See ``LLMClient.create_completion``."""
        return await self.client().create_completion(system, user, **kwargs)

    async def create_embeddings(self, texts: Any, **kwargs: Any) -> list[list[float]]:
        """Embed texts through this endpoint, preserving order."""
        return await self.client().create_embeddings(texts, **kwargs)

    async def list_models(self, *, embeddings_only: bool = False) -> list[str]:
        """Model slugs this endpoint accepts; ``[]`` when the catalog cannot be read."""
        if self.kind == LLMEndpointKind.DEVICE:
            return []
        return await self.client().list_models(embeddings_only=embeddings_only)

    async def probe(self) -> "ProbeResult":
        """Ask the provider whether this endpoint's credential works. Never raises."""
        from flow_sdk.external_apis.llm.client import ProbeResult  # noqa: PLC0415

        if self.kind == LLMEndpointKind.DEVICE:
            return ProbeResult(ok=False, message="a device login is proven by the vendor CLI, not by an API probe")
        return await self.client().probe()

    # ── local rows ──────────────────────────────────────────────────────────

    @classmethod
    async def find_by_secret(cls, secret_name: str) -> "LLMEndpoint | None":
        """The local row for a stored key, by its natural key.

        A LOOKUP, deliberately, not an id derived from the secret name: re-running must
        converge on the row that exists, including rows minted before any naming rule, and a
        query does that without making the id encode a fact about the thing.
        """
        if not secret_name:
            return None
        rows = await cls.get_all({"kind": LLMEndpointKind.API_KEY.value, "secret_name": secret_name})
        return rows[0] if rows else None

    @classmethod
    async def ensure_for_secret(cls, provider: str, *, secret_name: str = "") -> "LLMEndpoint":
        """The local row for a provider's stored key, created if it does not exist yet."""
        name = secret_name or f"{LM_SECRET_PREFIX}{provider}"
        existing = await cls.find_by_secret(name)
        if existing is not None:
            return existing
        endpoint = cls(provider=provider, kind=LLMEndpointKind.API_KEY, secret_name=name)
        await endpoint.save()
        return endpoint

    @classmethod
    def projection(cls, kind: "LLMEndpointKind | str", key: str, **fields: Any) -> "LLMEndpoint":
        """An endpoint that has no row, with an id derived from *key*. Never saved.

        The resolver has to name things that are not rows: a vendor device login, a provider
        the user has stored no key for, a hub budget named before any listing describes it.
        Each still needs a stable ``endpoint_typeid``, because the picker posts one back and
        a selection would flap if a re-list minted a new id.

        Derived, so it is stable; never saved, so the "rows are v4" policy is untouched.
        """
        from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

        return cls(id=mint_uuid(f"llm_endpoint:{kind}:{key}"), kind=kind, **fields)

    @classmethod
    def key_projection(cls, provider: str) -> "LLMEndpoint":
        """The endpoint for a provider's key when no row exists yet.

        It still resolves its own key, so a secret stored before any row existed is usable —
        the row is durability, not a gate. ``ensure_for_secret`` mints the real row by lookup
        once anything needs to persist against it.
        """
        secret = f"{LM_SECRET_PREFIX}{provider}"
        return cls.projection(LLMEndpointKind.API_KEY, secret, provider=provider, secret_name=secret)

    @classmethod
    def device_projection(cls, worker_type: str, *, name: str = "") -> "LLMEndpoint":
        """A device login as an endpoint. Derived on every read, never stored.

        The credential is the vendor CLI's own OAuth session, which the backend can never
        spend — hence ``invocable=False``.
        """
        return cls.projection(
            LLMEndpointKind.DEVICE,
            worker_type,
            harness=worker_type,
            name=name or f"{worker_type} device login",
            invocable=False,
        )

    @classmethod
    async def key_endpoints(cls) -> dict[str, "LLMEndpoint"]:
        """Every local key endpoint, keyed by secret name.

        One read for every caller that needs more than a single provider. The funding
        resolver runs per harness over the same handful of rows, so asking per provider per
        harness turned one query into a dozen identical ones.
        """
        rows = await cls.get_all({"kind": LLMEndpointKind.API_KEY.value})
        return {row.secret_name: row for row in rows if row.secret_name}

    async def save(self, owner=None, notify: bool = True) -> "LLMEndpoint":
        """Only local key endpoints have rows.

        A hub endpoint is the hub's row and a device login is the vendor CLI's session; storing
        either here would create a second copy that can only drift from the thing it mirrors.
        """
        if self.kind != LLMEndpointKind.API_KEY:
            raise ValueError(
                f"an {self.kind} endpoint is not stored on this box — only api_key endpoints have local rows"
            )
        return await super().save(owner=owner, notify=notify)
