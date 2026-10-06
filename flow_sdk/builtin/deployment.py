"""Deployment — the one placement record: this thing runs on that machine.

Every placement is this entity, whatever is placed and wherever it lands:

    Agent       → its loop on this computer, or a box of its own
    Project     → its web apps on a dev server, or a box of its own
    ComputeNode → the machine's own placement: its admin services (the box's
                  FlowPad), and on this computer the credential binding every
                  process without a deployment of its own reads
    GCP/AWS/…   → an inventoried cloud resource (the resource's own kind rides
                  on ``origin.kind`` — the kind of what it carries)

Two axes, each declared exactly once:

* the PARENT          — WHAT is placed (:attr:`Deployment.element_type`). There is
  no stored ``kind``: an entity's kind is derived (``docs/ontology.md`` rule 1),
  and what a placement serves is its endpoints' ``subkind``.
* ``target.provider`` — WHERE it runs: ``local``, ``e2b``, ``gcp``, ``aws``, …
  A provider is a *type of deployment*, never a parent of anything.

A box (a ``ComputeNode``) hosts deployments; on this computer many, in the cloud
one each. ``identity`` says who a box logs in as for it.

**Parenting: a Deployment is a child of the deployed element**, and the chain
reaches a Project. ``artifact_id`` is a REFERENCE, not parenting — an Artifact
is how the thing was generated, and lives in its own project under its own
parent.

**Ids are UUID v4, minted once, and identical on the hub and here** — which is
exactly what the inherited ``remote`` flag already promises ("has a hub
counterpart at the same id"). There is no derived id: re-running a deploy
converges through :meth:`find_existing`, never through a key baked into the id.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Literal, Optional

from pydantic import BaseModel, PrivateAttr, field_validator

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.core import Entity, action
from flow_sdk.schema.data_spec.credential_contract import DEFAULT_ENVIRONMENT
from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec, hub_store
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.service_endpoint_spec import EndpointDeclaration
from flow_sdk.schema.types import EntityType
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry
from flow_sdk.worldview.models import (
    ArtifactLinkSource,
    DeploymentObservation,
    DeploymentObservationKind,
    DeploymentStatus,
    DeploymentTarget,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
    from flow_sdk.secrets import SecretStoreRef

#: Per event loop, per deployment (``stream_inbox/_locks``): ``keep_in``'s read-modify-write of a binding.
_SECRETS_LOCKS = new_registry()

#: Who a box logs in as for a deployment: nobody, the placed agent's own identity, or its owner.
DeploymentIdentity = Literal["none", "agent", "user"]

#: Providers that place a resource on a ComputeNode, so ``origin.external_id``
#: names that node. An inventoried ``gcp`` resource is not node-backed — its
#: ``external_id`` is the provider's own resource name.
#:
#: The UNION of every tier's node providers. The hub allocates ``e2b`` /
#: ``docker`` / ``gcp_vm`` boxes; ``user_machine`` is a machine its owner
#: enrolled with ``flow connect``, which the hub never allocates and so does not
#: list. ``local_machine`` is a hub's own host running a node's isolated instance --
#: a local hub (``DEPLOY_ENV=local``) only. A hub-adopted ``gcp_vm`` placement used to resolve ``compute_node_id``
#: to None here — unaddressable, and refused by every "provider in
#: NODE_PROVIDERS" validation — because this set only knew the providers THIS
#: tier could place on.
NODE_PROVIDERS = frozenset({"local", "local_machine", "e2b", "docker", "gcp_vm", "user_machine"})

logger = logging.getLogger(__name__)


class AgentUnavailable(RuntimeError):
    """The placed agent is missing (``NOT_FOUND``) or disabled (``REFUSED``).

    Raised by the process primitive; a boundary that forms an answer turns it
    into one with ``exit_code`` — the two cases are different answers, and a
    bare ``RuntimeError`` left a caller no way to tell them apart.
    """

    def __init__(self, message: str, exit_code: ExitCode):
        super().__init__(message)
        self.exit_code = exit_code

    def answer(self) -> "PromptResult":
        """This as the answer a launch gives: refused, or no such agent."""
        from flow_sdk.schema.data_spec.returned_value_spec import PromptResult  # noqa: PLC0415

        make = PromptResult.refused if self.exit_code is ExitCode.REFUSED else PromptResult.not_found
        return make(str(self))


class DeploymentActionError(RuntimeError):
    """A placement verb the caller has to fix. ``status_code`` rides to HTTP."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _bare_node_id(node_id: str) -> str:
    """A node id without its ``compute_node-`` TypeId prefix.

    A hub-created placement records its node as a TypeId string while
    ``ComputeNode._local_id()`` is the bare uuid, so an unnormalized comparison
    read every hub-created row as "not here" — on the box it runs on too.
    """
    prefix = "compute_node-"
    return node_id[len(prefix):] if node_id.startswith(prefix) else node_id


async def _place_mcp_specs(agent, names: "list[str] | None") -> list:
    """The MCP servers a launch gets: the agent's own, or a place's named set.

    A place names servers (names travel between machines; ids do not). A name the
    agent already carries uses that attached copy; otherwise the first Mcp asset of
    that name on this machine. A name that resolves nowhere is skipped with a warning
    — a dangling override must not make the agent unlaunchable.
    """
    specs = await agent.resolved_mcp_specs()
    if names is None:
        return specs
    from flow_sdk.builtin.mcp import Mcp  # noqa: PLC0415

    by_name = {spec.name: spec for spec in specs}
    chosen = []
    for name in names:
        spec = by_name.get(name)
        if spec is None:
            rows = await Mcp.get_all({"match": {"name": name}})
            spec = rows[0].to_spec() if rows else None
        if spec is None:
            logger.warning("place override names MCP server %r, which does not resolve here — skipped", name)
            continue
        chosen.append(spec)
    return chosen


class PlacementOrigin(BaseModel):
    """Where a placement lives: the ComputeNode it runs on, or the provider's own resource.

    Not a ``CloudOrigin``. A record identity has a key from birth; a placement is created
    before it is placed (``external_id`` stays empty until a node is allocated) and its
    ``provider`` is the tier that placed it, which is load-bearing here and not identity
    there. The hub's ``Deployment.origin`` has this exact shape.
    """

    kind: str = ""
    provider: str = ""
    external_id: str = ""
    url: str = ""


class Deployment(Entity):
    """A provider-neutral placement and observation record."""

    # A remote placement's hub row owns the machine: deleting here without the hub would leave
    # the machine running with no handle to it.
    owns_hub_delete: ClassVar[bool] = True

    type: str = APIField(default=EntityType.DEPLOYMENT.value)
    name: str = APIField(description="Display name")
    #: Who the machine logs in as for this placement: ``agent`` (the placed agent's own identity),
    #: ``user`` (its owner), ``none`` (not logged in). Resolved server-side, never from a request.
    identity: DeploymentIdentity = APIField(default="user", description="Who the box logs in as: none, agent or user")
    artifact_id: str | None = APIField(default=None, description="Referenced Artifact (not the parent)")
    artifact_link_source: ArtifactLinkSource | None = APIField(default=None)
    target: DeploymentTarget = APIField(description="Provider placement target — WHERE it runs")
    # PRIVATE: for a provider in ``NODE_PROVIDERS`` this `external_id` names a
    # LOCAL ComputeNode, so the field is only conditionally transportable — and a
    # per-field policy cannot say "sometimes". Nothing reads it on a receiver
    # (the only consumer is the local WorldView projection), so the safe answer
    # is also the free one.
    origin: PlacementOrigin | None = APIField(
        default=None,
        sharing=Sharing.PRIVATE,
        description="The cloud resource this places: the ComputeNode it runs on, or the provider's own resource",
    )
    status: DeploymentStatus = APIField(default_factory=DeploymentStatus)
    provider_labels: dict[str, str] = APIField(
        default_factory=dict,
        description="Provider-native labels and local-provider configuration",
    )
    observations: dict[DeploymentObservationKind, DeploymentObservation] = APIField(
        default_factory=dict,
        description="Provider-normalized cost, size, and activity observations",
    )
    source_revision: str | None = APIField(default=None)
    #: The credential environment processes placed here read their values from.
    #: ``development`` is this computer; a cloud placement defaults to ``production``.
    environment: str = APIField(
        default=DEFAULT_ENVIRONMENT,
        description="Credential environment: development (this computer) or a named one (production, staging, ...)",
    )
    #: The placement's own token allocation on the hub (an ``llm_endpoint`` typeid), set by planning it with a
    #: ``token_allocation``; blank = its agent spends its owner's capped default.
    llm_endpoint_typeid: str = APIField(default="", description="This placement's token allocation (hub LLM endpoint)")

    #: Where this placement's credential values live (the WHERE a credential never says). ``None``:
    #: this computer's — an agent's local deployment reads what the rest of this machine reads.
    #: PRIVATE: a store binding names this machine's files and vault.
    secrets: DeploymentSecretsSpec | None = APIField(
        default=None,
        sharing=Sharing.PRIVATE,
        description="Where credential values live here: a store, per-variable exceptions, extra required variables",
    )

    #: What this deployment DECLARES it exposes — every service it runs, what for, what it speaks and how
    #: to tell it is alive. Its ``ServiceEndpoint`` rows serve the declaration (:meth:`sync_endpoints`);
    #: a declared service no row serves is failing in the node's health report.
    exposes: list[EndpointDeclaration] = APIField(
        default_factory=list, description="The services this deployment declares it exposes"
    )
    #: A local agent deployment that RUNS: a subprocess on this machine running its loop
    #: (``builtin/agent_loop``). A placement processes are only spawned through does not.
    serving: bool = APIField(default=False, description="A local deployment that runs its own agent loop process")
    #: The Python file that process runs instead of the stock loop; ``None`` runs the stock loop.
    snippet: str | None = APIField(default=None, description="The loop this deployment runs, when not the stock one")

    #: The deployed element, when the caller already had it. Not just a cache: a
    #: SHIPPED agent resolved off disk on a cold instance is never persisted, so
    #: reading it back by ``parent_type_id`` would find nothing at all.
    _element: Optional[Entity] = PrivateAttr(default=None)

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        if "identity" not in data and str(data.get("parent_type_id") or "").startswith("agent-"):
            # A row stored before ``identity`` existed: an agent's placement logs in as the agent (the hub
            # reads legacy rows the same way).
            data["identity"] = "agent"
        super().__init__(**data)

    def with_element(self, element: Optional[Entity]) -> "Deployment":
        """Attach the already-loaded deployed element. Returns self, for chaining."""
        self._element = element
        return self

    # ── this computer ─────────────────────────────────────────────────────

    @classmethod
    async def this_computer(cls, *, save: bool = True) -> "Deployment":
        """This computer's own placement — the local ComputeNode's, found, else created once (a lookup,
        never a minted key). ``save=False`` (a dry run) returns an unsaved one instead of creating it.

        Its ``secrets`` are the binding every process without a deployment of its own reads with —
        terminals, ``flow credentials``, project setup — and it is where a project-less web app on this
        machine is served from. Its environment is not stored: it is the instance default
        (``development``; a cloud box adopts ``production``), read as it is now.
        """
        from flow_sdk.instance_settings.environment import get_default_environment  # noqa: PLC0415

        parent = _local_node_typeid()
        row = await cls.find_existing(parent, "local")
        if row is None:
            row = cls(
                name="This computer",
                parent_type_id=parent,
                identity="user",
                target=DeploymentTarget(provider="local", scope="machine", location="this computer"),
                secrets=DeploymentSecretsSpec(),
            )
            if save:
                await row.save()
        row.environment = get_default_environment()
        return row

    @classmethod
    async def others(cls) -> "list[Deployment]":
        """Every deployment but this computer."""
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        parent = _local_node_typeid()
        # "Not (this node's parent AND local)", pushed down: a null parent is named, since SQL's != drops it.
        rows = await cls.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.OR, operands=[
            ExpressionNode(op=QueryOp.NE, operands=["parent_type_id", parent]),
            ExpressionNode(op=QueryOp.IS_NULL, operands=["parent_type_id"]),
            ExpressionNode(op=QueryOp.NE, operands=["target.provider", "local"]),
        ])))
        return [row for row in rows if not (str(row.parent_type_id) == parent and row.target.provider == "local")]

    @classmethod
    async def resolve(cls, deployment_id: str = "") -> "Deployment":
        """The deployment ``deployment_id`` names (an id or a ``deployment-`` typeid); empty is this
        computer. Raises ``LookupError`` for one that does not exist."""
        deployment_id = str(deployment_id or "").strip().removeprefix("deployment-")
        if not deployment_id:
            return await cls.this_computer()
        row = await cls.get_by_id(deployment_id)
        if row is None:
            raise LookupError("deployment not found")
        return row

    @property
    def element_type(self) -> Optional[str]:
        """What this places — the type of its parent (``agent``, ``project``, ``compute_node``…), or None."""
        from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

        try:
            return TypeId(str(self.parent_type_id)).type if self.parent_type_id else None
        except (ValueError, TypeError):
            return None

    @property
    def places_agent(self) -> bool:
        return self.element_type == EntityType.AGENT.value

    @property
    def is_this_computer(self) -> bool:
        return str(self.parent_type_id or "") == _local_node_typeid() and self.target.provider == "local"

    async def secrets_binding(self) -> DeploymentSecretsSpec:
        """Where this placement's values live: its own binding, else this computer's."""
        if self.secrets is not None:
            return self.secrets
        return (await type(self).this_computer()).secrets or DeploymentSecretsSpec()

    async def keep_in(self, env_vars: list[str], store: "SecretStoreRef") -> "Deployment":
        """Keep ``env_vars``' values in ``store`` here: an exception on this placement's own binding
        (a placement that inherited this computer's gets a copy first). Existing values are not moved.

        A read-modify-write of ONE shared binding, so it is serialized per deployment and starts from
        the stored row, never from this instance's copy: two credentials saved at once (each holding
        the deployment it loaded before the other wrote) would otherwise each write back the binding
        it read, and the first one's variables silently fall back to the default store."""
        async with keyed_loop_lock(_SECRETS_LOCKS, str(self.id)):
            stored = await type(self).get_by_id(str(self.id)) if self.id else None
            row = stored if stored is not None else self
            binding = await row.secrets_binding()
            row.secrets = binding.with_store(list(env_vars), store)
            await row.save()
            self.secrets = row.secrets
        return self

    async def release(self, env_vars: list[str]) -> "Deployment":
        """Drop this placement's own exceptions for ``env_vars``: their values fall back to its
        default store. The undo of :meth:`keep_in`, under the same per-deployment lock; a placement
        with no exception for any of them is left untouched (not even saved)."""
        async with keyed_loop_lock(_SECRETS_LOCKS, str(self.id)):
            stored = await type(self).get_by_id(str(self.id)) if self.id else None
            row = stored if stored is not None else self
            if row.secrets is None or not set(env_vars) & set(row.secrets.exceptions):
                return self
            row.secrets = row.secrets.with_store(list(env_vars), row.secrets.store)
            await row.save()
            self.secrets = row.secrets
        return self

    # ── a cloud placement's secrets, held by the hub ──────────────────────

    async def authorize(self, provider: str, permissions: list[str] | None = None) -> dict:
        """Let this deployment's machine use your ``provider`` connection: it asks the hub for a fresh
        token when it needs one; your refresh token never leaves the hub. Revoke with :meth:`revoke`."""
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        return await hub_post(self.type, {"provider": provider, "permissions": list(permissions or [])},
                              self.id, "authorize") or {}

    async def revoke(self, provider: str) -> list[str]:
        """Take back ``provider``: the machine's next token ask is refused."""
        from flow_sdk.cloud_client.transport.hub_http import hub_delete  # noqa: PLC0415

        data = await hub_delete(self.type, self.id, action="authorize", sub_path=provider) or {}
        return list(data.get("revoked") or [])

    async def authorizations(self) -> list[dict]:
        """The connections this deployment's machine may use (``{provider, permissions}``). Names only."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        return list(await hub_get_or_raise(self.type, self.id, action="authorize") or [])

    async def secrets_inventory(self) -> dict:
        """What the hub holds for this deployment: each name with its last write and placement, and the
        connections its machine may use. Names only."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        return await hub_get(self.type, self.id, action="secrets") or {"secrets": [], "authorizations": []}

    async def funding(self) -> dict | None:
        """What pays for this cloud placement's model turns (``kind``: ``allocation`` | ``default``, the
        endpoint's ``name``) and ``exhausted``: the used-up limit its next turn would be refused with, or
        empty. ``None`` when the hub cannot say."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        return await hub_get(self.type, self.id, action="funding")

    # ── convergence ───────────────────────────────────────────────────────

    @classmethod
    async def find_existing(
        cls,
        parent_type_id: str,
        provider: str,
        *,
        environment: str | None = None,
    ) -> Optional["Deployment"]:
        """The placement of *parent_type_id* on *provider* (in *environment*, when given), or None.

        THE idempotency seam. Re-deploying converges here rather than on a
        derived id: an id is a name, not a fact about the thing, and a key baked
        into one can never change afterwards. Same shape as
        ``SourceItem.find_existing`` / ``DataSource.find_for_account``.

        ``target.provider`` lives inside a JSON column, so it is matched in
        Python rather than in the query — a nested-JSON predicate is not a
        supported filter, and the row count per element is tiny.
        """
        rows = await cls.get_all({"match": {"parent_type_id": str(parent_type_id)}})
        wanted = str(provider).strip()
        for row in rows:
            if row.target.provider != wanted:
                continue
            # One placement per environment: a staging and a production machine
            # of the same element on the same provider are two rows.
            if environment is not None and (row.environment or DEFAULT_ENVIRONMENT) != environment:
                continue
            return row
        return None

    @classmethod
    async def upsert(
        cls,
        *,
        parent_type_id: str,
        provider: str,
        payload: dict[str, Any],
        element: Optional[Entity] = None,
    ) -> "Deployment":
        """Create the placement, or update it in place when something changed.

        The no-op case has to be a REAL no-op: resolving a deployment happens on
        every launch, and a save costs a SQL UPDATE, a WS broadcast to every
        connected client, and a metadata.json read+write.

        Change detection dumps BOTH sides to JSON and compares once. A per-field
        ``getattr(existing, f) != v`` walk looks equivalent and is not:
        ``target``/``origin``/``status`` are pydantic models while the payload
        supplies plain dicts, and ``BaseModel.__eq__`` against a dict returns
        ``NotImplemented`` — so the guard was True on 100% of calls and every
        resolve wrote.
        """
        body = {**payload, "parent_type_id": str(parent_type_id)}
        existing = await cls.find_existing(parent_type_id, provider, environment=payload.get("environment"))
        if existing is None:
            body.setdefault("status", {}).setdefault("observed_at", datetime.now(UTC).isoformat())
            deployment = cls(**body)
            await deployment.save()
            return deployment.with_element(element)

        keys = set(body)
        candidate = cls(id=existing.id, **body)
        if existing.model_dump(mode="json", include=keys) != candidate.model_dump(mode="json", include=keys):
            existing.apply_field_updates(body)
            await existing.save()
        return existing.with_element(element)

    async def rekey(self, new_id: str, **changes: Any) -> "Deployment":
        """This placement, at *new_id* — the hub's id for it. Returns the re-keyed row.

        One placement, one id everywhere: a box re-keys the local placement it
        minted rather than translating ids at every read. What the placement
        exposes moves with it; the old edge is cut first, because deleting the old
        row cascades to its children. *changes* are applied on the way.
        """
        from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

        data = self.model_dump(mode="json", exclude={"id", "created_date", "updated_date", "remote"})
        adopted = Deployment(**{**data, **changes, "id": new_id})
        await adopted.save()
        for endpoint in await ServiceEndpoint.of_deployment(str(self.typeid)):
            endpoint.parent_type_id = str(adopted.typeid)
            await endpoint.save()
            await adopted.attach_child(endpoint)
            await self.detach_child(endpoint.typeid, notify=False)
        await self.delete()
        logger.info("placement %s re-keyed to %s", self.id, new_id)
        return adopted

    @classmethod
    async def adopt_from_hub(cls, payload: Any, element: Optional[Entity] = None) -> Optional["Deployment"]:
        """Store a hub-created placement locally, AT THE HUB'S ID.

        Adopt, never re-mint. One placement is one id everywhere — that is what
        the inherited ``remote`` flag already asserts ("has a hub counterpart at
        the same id"), and re-minting here would fork the row the moment the hub
        pushed an update for it down the bridge.
        """
        if not isinstance(payload, dict) or not payload.get("id"):
            return None
        existing = await cls.get_by_id(str(payload["id"]))
        deployment = cls(**payload)
        deployment.remote = True
        # Where its values live is this machine's, never the hub's: kept across adoptions. A new cloud
        # placement keeps them in the hub store, which places them on its machine.
        deployment.secrets = existing.secrets if existing is not None and existing.secrets is not None else (
            None if deployment.is_local else DeploymentSecretsSpec(store=hub_store(str(deployment.id)))
        )
        await deployment.save()
        return deployment.with_element(element)

    # ── placement ─────────────────────────────────────────────────────────

    @property
    def compute_node_id(self) -> str | None:
        """The machine this placement runs on, or None if it is not node-backed.

        THE addressing seam. A run is not "execute here" — it is "execute on the
        node this deployment is placed on", which is what lets the same call
        mean a local spawn today and a message to a remote node's bus later.
        """
        if self.target.provider not in NODE_PROVIDERS:
            return None
        external = (self.origin.external_id if self.origin else "") or ""
        if external:
            # Normalized HERE, the addressing seam, so every reader gets the bare id.
            return _bare_node_id(external)
        # No node recorded. Falling back to THIS machine is only correct for the
        # `local` provider — for a cloud placement it would report `is_local`
        # True and let `dispatch_agent_run` execute here while claiming the run
        # happened in the cloud, which is the exact lie that module refuses to
        # tell. A cloud row without a node is unaddressable, and says so.
        if self.target.provider != "local":
            return None
        # Pure — no DB read, no mint side-effect, the same reason `node_on_tag`
        # uses the deterministic id.
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        return ComputeNode._local_id()

    @property
    def is_local(self) -> bool:
        """Whether this runs on the machine we are executing on.

        Deliberately an id comparison and NOT ``target.provider == "local"``: a
        sandbox runs its own FlowPad backend, so a provider test would answer
        differently depending on which tier asked it. An id answers the same
        everywhere.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        node_id = self.compute_node_id
        return node_id is not None and node_id == ComputeNode._local_id()

    async def endpoints(self) -> list:
        """What this placement exposes — one ``ServiceEndpoint`` per service it answers on.

        Replaces the port label and the ``host_url`` guess: where a placement is
        reached is a fact about each thing it serves, not one string on the row.
        """
        from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

        return await ServiceEndpoint.of_deployment(str(self.typeid))

    def declare(self, *declarations: EndpointDeclaration) -> bool:
        """Add *declarations* to what this deployment exposes, by name (a re-declared name replaces its
        entry). Returns whether anything changed — the caller saves."""
        by_name = {d.name: d for d in self.exposes}
        before = dict(by_name)
        by_name.update({d.name: d for d in declarations})
        if by_name == before:
            return False
        self.exposes = list(by_name.values())
        return True

    async def sync_endpoints(self) -> list:
        """Make its ``ServiceEndpoint`` rows serve the declaration: each declared service gets its row
        (found by name — never a derived id), carrying the declared subkind, protocol and check. A
        declaration whose backend is not known yet (a port not picked, a channel not made) keeps the
        row's backend, or waits for whoever places it. Rows it does not declare are left alone — a dev
        server shown by port is registered as it runs."""
        from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
        from flow_sdk.builtin.webapp_placement import upsert_endpoint  # noqa: PLC0415

        rows = []
        for declared in self.exposes:
            existing = await ServiceEndpoint.find_existing(str(self.typeid), declared.name)
            backend = declared.backend or (existing.backend if existing is not None else None)
            if backend is None:
                continue
            row, _saved = await upsert_endpoint(
                self,
                name=declared.name,
                subkind=declared.subkind,
                protocol=declared.model_dump(mode="json")["protocol"],
                backend=backend.model_dump(mode="json") if hasattr(backend, "model_dump") else backend,
                check=declared.check.model_dump(mode="json") if declared.check is not None else None,
                project_id=self.project_id,
                existing=existing,
            )
            rows.append(row)
        return rows

    async def health(self) -> str:
        """As healthy as its least healthy service, by each endpoint's last check. Derived, never stored."""
        from flow_sdk.schema.data_spec.health_spec import worst  # noqa: PLC0415

        return worst(e.health.state if e.health else "unknown" for e in await self.endpoints())

    @action.get(action_name="endpoints")
    async def endpoints_action(self):
        """`GET /deployment/<id>/endpoints` — what this placement serves.

        For a cloud placement the hub is authoritative: its rows are read now and
        adopted here at the hub's ids (``remote``), so a ``service`` call on one is
        forwarded to the hub, and the hub to the machine — the way a desktop chats
        with an agent placed in a box.
        """
        from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if self.remote:
            from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

            data = await hub_http.hub_get(self.get_type(), self.id, "endpoints")
            rows = data.get("endpoints") if isinstance(data, dict) else None
            if not isinstance(rows, list):
                return ApiFailResponse(message="the hub did not answer for this cloud placement", status_code=502)
            endpoints = [e for e in [await ServiceEndpoint.adopt_from_hub(row) for row in rows] if e is not None]
        else:
            endpoints = await self.endpoints()
        return ApiSuccessResponse(data={"endpoints": [e.model_dump(mode="json") for e in endpoints]})

    async def element(self) -> Optional[Entity]:
        """The entity this places — the parent. Agent, WebApp, ComputeNode…

        Resolved through the registry rather than a per-kind ``if`` ladder, so a
        new deployable element needs no change here. ``TypeId`` has no
        ``.parse`` — the constructor does the parsing.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

        if self._element is not None:
            return self._element
        if not self.parent_type_id:
            return None
        try:
            ref = TypeId(str(self.parent_type_id))
        except ValueError:
            return None
        entity_cls = SchemaRegistry.get_entity_cls(ref.type)
        if entity_cls is None:
            return None
        # Memoized: a list of deployments builds rows without an element, so
        # without this every element() call re-issues the same lookup.
        self._element = await entity_cls.get_by_id(ref.id)
        return self._element

    async def pause(self) -> bool:
        """Stop the machine without losing the row.

        Terminate is a PAUSE, not a delete: the row carries the placement's cost
        and activity observations, and deleting it throws away the only history
        we have of what the box cost. Hard deletion is a separate, explicit act.

        A REMOTE placement is paused by the hub — the box is its resource and we
        cannot reach the provider from here. The row then comes back down the
        bridge like any other hub update, so this doesn't write the status
        locally in that case; doing both would race the push.
        """
        if self._runs_here():
            return await self._set_serving(False)
        return await self._set_node_state("pause", "paused")

    async def delete(self):
        """Delete the placement: a process serving it here is stopped first, and a remote one is
        deleted on the hub first (``owns_hub_delete``) — the hub stops its machine."""
        if self._runs_here():
            await self._stop_process()
        return await super().delete()

    async def resume(self) -> bool:
        """Start a paused machine again. The counterpart of :meth:`pause`, same routing."""
        if self._runs_here():
            return await self._set_serving(True)
        return await self._set_node_state("resume", "running")

    def _runs_here(self) -> bool:
        """An agent deployment on this machine: it runs as a process here, so pausing it stops that
        process (``serving``) — never the machine under it."""
        return not self.remote and self.is_local and self.places_agent

    async def _set_serving(self, serving: bool) -> bool:
        """Stop (or start) this deployment's process. Stopping ends it now — and, not serving, the
        app's supervisor will not start it again; starting is the supervisor's (``serving``)."""
        self.serving = serving
        self.status = self.status.model_copy(update={"provider_state": "running" if serving else "paused"})
        await self.save()
        if not serving:
            await self._stop_process()
        return True

    async def _stop_process(self) -> None:
        """End this deployment's process here, if it runs."""
        import asyncio  # noqa: PLC0415

        from flow_sdk.builtin import deployment_process  # noqa: PLC0415

        if deployment_process.alive(self):
            await asyncio.to_thread(deployment_process.stop, self)

    async def _set_node_state(self, verb: str, provider_state: str) -> bool:
        """Pause or resume the machine: through the hub for a remote placement, else on the node here."""
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        if self.remote:
            await self._hub_action(verb)
            return True
        node_id = self.compute_node_id
        if node_id is None:
            return False
        node = await ComputeNode.get_by_id(node_id)
        if node is None:
            return False
        await getattr(node, verb)()
        self.status = self.status.model_copy(
            update={"provider_state": provider_state, "observed_at": datetime.now(UTC).isoformat()}
        )
        await self.save()
        return True

    async def update(self) -> dict[str, Any]:
        """Bring a cloud machine to the published definition.

        The hub re-clones the published repository into the box's project and
        re-indexes it, then stamps ``source_revision``. This computer has no
        "update": its definition IS the files on disk.
        """
        if self.is_local:
            raise DeploymentActionError("this computer already runs the definition on disk", status_code=409)
        return await self._hub_action("update")

    async def remote_runs(self, limit: int) -> list[dict[str, Any]]:
        """The latest runs ON a cloud machine, read through the hub.

        Local runs are the local ``/runs`` list; a box's runs live in the box's
        own database, which only the hub can reach.
        """
        if self.is_local:
            raise DeploymentActionError("this computer's runs are the local run list", status_code=409)
        from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

        data = await hub_http.hub_get(self.get_type(), self.id, "runs", params={"limit": str(int(limit))})
        if not isinstance(data, dict):
            raise DeploymentActionError("the hub did not answer for this cloud machine", status_code=502)
        # The hub already drops anything that is not a run.
        return list(data.get("runs") or [])

    async def _hub_action(self, verb: str) -> dict[str, Any]:
        """POST one action on this placement's hub row; the row itself comes back down the bridge."""
        from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

        data = await hub_http.hub_post(self.get_type(), {}, self.id, verb)
        if data is None:
            raise DeploymentActionError(f"cloud login required to {verb} a cloud machine", status_code=401)
        return data if isinstance(data, dict) else {}

    @action.post(action_name="pause")
    async def pause_action(self):
        """`POST /deployment/<id>/pause` — stop this placement's machine."""
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            paused = await self.pause()
        except Exception as exc:  # noqa: BLE001
            return ApiFailResponse(message=f"pause failed: {exc}")
        if not paused:
            return ApiFailResponse(message="this deployment has no machine to pause")
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    async def _answer(self, verb: str, run):
        """One envelope for the placement verbs: a caller error keeps its status, a hub failure is a 502."""
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            return ApiSuccessResponse(data=await run())
        except DeploymentActionError as exc:
            return ApiFailResponse(message=str(exc), status_code=exc.status_code)
        except HubError as exc:
            return ApiFailResponse(message=f"{verb} failed on the hub: {exc}", status_code=502)

    @action.post(action_name="resume")
    async def resume_action(self):
        """`POST /deployment/<id>/resume` — start this placement's paused machine."""

        async def run():
            if not await self.resume():
                raise DeploymentActionError("this deployment has no machine to resume")
            return self.model_dump(mode="json")

        return await self._answer("resume", run)

    @action.post(action_name="update")
    async def update_action(self):
        """`POST /deployment/<id>/update` — bring a cloud machine to the published definition."""
        return await self._answer("update", self.update)

    @action.get(action_name="secrets")
    async def secrets_action(self):
        """`GET /deployment/<id>/secrets` — what the hub holds for this cloud placement. Names only."""
        return await self._answer("secrets", self.secrets_inventory)

    @action.post(action_name="authorize")
    async def authorize_action(self):
        """`POST /deployment/<id>/authorize  {"provider", "permissions"?}` — let its machine use your
        connection; `{"provider", "revoke": true}` takes it back."""
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        body = ((await request_info.get_post_data()) if request_info else None) or {}
        provider = str(body.get("provider") or "").strip()

        async def run():
            if not provider:
                raise DeploymentActionError("provider is required", status_code=400)
            if body.get("revoke"):
                return {"revoked": await self.revoke(provider)}
            return await self.authorize(provider, list(body.get("permissions") or []))

        return await self._answer("authorize", run)

    @action.get(action_name="timeline")
    async def timeline_action(self):
        """`GET /deployment/<id>/timeline?limit=&before=&conversation=` — what reached it, what it
        ran, what it answered. Newest first, read from the rows (``builtin/deployment_timeline``);
        ``conversation`` narrows it to one thread; ``before`` (the previous page's) pages back.
        """
        from flow_sdk.builtin.deployment_timeline import timeline  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        raw_limit = str((request_info.get_param("limit") if request_info else None) or "")
        raw_before = str((request_info.get_param("before") if request_info else None) or "")
        limit = min(int(raw_limit), 200) if raw_limit.isdigit() and int(raw_limit) > 0 else 50
        before = None
        if raw_before:
            try:
                before = datetime.fromisoformat(raw_before.replace("Z", "+00:00"))
            except ValueError:
                return ApiFailResponse(message=f"before={raw_before!r} is not an ISO time", status_code=400)
        conversation = str((request_info.get_param("conversation") if request_info else None) or "").strip() or None
        page = await timeline(self, limit=limit, before=before, conversation=conversation)
        return ApiSuccessResponse(data=page.model_dump(mode="json"))

    @action.get(action_name="threads")
    async def threads_action(self):
        """`GET /deployment/<id>/threads` — the conversations it holds (a chat, a whole phone call),
        the active ones first, each with its status now (``live`` / ``working`` / ``ended`` / ``idle``)."""
        from flow_sdk.builtin.deployment_timeline import threads  # noqa: PLC0415
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        return ApiSuccessResponse(data=(await threads(self)).model_dump(mode="json"))

    def _local_process(self):
        from flow_sdk.builtin import deployment_process  # noqa: PLC0415
        from flow_sdk.schema.data_spec.deployment_timeline_spec import DeploymentProcess  # noqa: PLC0415

        return DeploymentProcess(
            deployment_id=str(self.id), shell_id=deployment_process.shell_id_of(self),
            file=str(deployment_process.file_of(self)), command=deployment_process.command_of(self),
            pid=deployment_process.pid_of(self), serving=bool(self.serving),
        )

    @action.get(action_name="process")
    async def process_action(self):
        """`GET /deployment/<id>/process` — a local deployment's process: its file, its terminal, its pid."""
        import asyncio  # noqa: PLC0415

        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.is_local:
            return ApiFailResponse(message="only a local deployment runs a process here", status_code=400)
        return ApiSuccessResponse(data=(await asyncio.to_thread(self._local_process)).model_dump(mode="json"))

    @action.get(action_name="code")
    async def code_action(self):
        """`GET /deployment/<id>/code` — the text of the Python file a local deployment runs."""
        from flow_sdk.builtin import deployment_process  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415
        from flow_sdk.schema.data_spec.deployment_timeline_spec import DeploymentCode  # noqa: PLC0415

        if not self.is_local:
            return ApiFailResponse(message="only a local deployment runs a file here", status_code=400)
        path = deployment_process.file_of(self)
        return ApiSuccessResponse(data=DeploymentCode(file=str(path), text=path.read_text(encoding="utf-8")).model_dump(mode="json"))

    @action.post(action_name="save_code")
    async def save_code_action(self):
        """`POST /deployment/<id>/save_code {text}` — write the file; it runs from the next (re)start."""
        from flow_sdk.builtin import deployment_process  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415
        from flow_sdk.schema.data_spec.deployment_timeline_spec import DeploymentCode  # noqa: PLC0415

        request_info = get_current_request_info()
        text = ((await request_info.get_post_data()) or {}).get("text") if request_info else None
        if not self.is_local or not isinstance(text, str):
            return ApiFailResponse(message="a local deployment's file takes {text: <python>}", status_code=400)
        path = deployment_process.file_of(self)
        path.write_text(text, encoding="utf-8")
        return ApiSuccessResponse(data=DeploymentCode(file=str(path), text=text).model_dump(mode="json"))

    @action.post(action_name="restart")
    async def restart_action(self):
        """`POST /deployment/<id>/restart` — stop the loop; the supervisor runs the file again at once
        (this write is what tells it), in the same terminal."""
        import asyncio  # noqa: PLC0415

        from flow_sdk.builtin import deployment_process  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.is_local or not self.serving:
            return ApiFailResponse(message="only a running local deployment restarts", status_code=400)
        if not await asyncio.to_thread(deployment_process.stop, self):
            return ApiFailResponse(message="its process did not stop", status_code=500)
        await self.save()
        return ApiSuccessResponse(data=(await asyncio.to_thread(self._local_process)).model_dump(mode="json"))

    @action.get(action_name="runs")
    async def runs_action(self):
        """`GET /deployment/<id>/runs?limit=` — the latest runs on a cloud machine; the hub bounds ``limit``."""
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        raw = str((request_info.get_param("limit") if request_info else None) or "")
        limit = int(raw) if raw.isdigit() else 8

        async def run():
            return {"runs": await self.remote_runs(limit)}

        return await self._answer("runs", run)

    # ── the launch verbs (agent placements) ───────────────────────────────

    async def agent(self) -> Optional["Agent"]:
        """The Agent this places, when it places one."""
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

        element = await self.element()
        return element if isinstance(element, Agent) else None

    def is_agent_placement_of(self, agent) -> bool:
        """The one rule for "may this placement open a session as ``agent``":
        its row, an agent placement, on a machine — the hub asks the same."""
        return str(self.parent_type_id) == str(agent.typeid) and self.target.provider in NODE_PROVIDERS

    async def _require_agent(self) -> "Agent":
        """The placed Agent, or ``AgentUnavailable`` — a launch site naming a
        missing or disabled agent is a bug we want to see, not a silent no-op.

        Raised, because ``create_process`` is a primitive that hands back a
        process. A boundary that forms an ANSWER (a turn, a launch) catches it
        and answers with ``exit_code`` instead."""
        agent = await self.agent()
        if agent is None:
            raise AgentUnavailable(
                f"deployment {self.id}: agent {self.parent_type_id!r} not found", ExitCode.NOT_FOUND,
            )
        if not agent.enabled_on(self.id):
            raise AgentUnavailable(
                f"agent {agent.name!r} is disabled on {self.name or self.id}", ExitCode.REFUSED,
            )
        return agent

    async def create_process(self, prompt: str = "", **options) -> "AgenticProcess":
        """Project the deployed agent onto an AgenticProcess. Not saved, not started.

        The primitive. Every field the agent declares (worker, model,
        permissions, system prompt) comes from the Agent; only per-run concerns
        (``visible``, ``process_type``, ``context_data``, ``workdir``,
        ``pty_mode``, …) are accepted here and passed through.

        A separate verb rather than a pair of ``launch`` flags because most
        callers genuinely want only this half: they own the save (to add
        ``notify``/``owner``), or the start (to attach a Shell, or drive the
        turns themselves), or neither — ``flow diagnose`` and the migration
        runner both spawn from a process that is never persisted at all.
        """
        from flow_sdk.builtin.agent import worker_type_value  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process.agentic_process import selected_worker_type  # noqa: PLC0415
        from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

        agent = await self._require_agent()
        # This place's overrides (agent.json ``places``) win over the definition
        # for every launch through it — chat, run, schedule, email alike.
        place = agent.place_for(self.id)
        place_mcp = place.mcp_servers if place is not None else None
        if place is not None:
            agent = agent.model_copy(update={k: v for k, v in place.overrides().items() if k != "mcp_servers"})

        # A per-run worker override has to reach BOTH sides — the options object
        # (dispatched on the driver key) and the process field (a WorkerType
        # enum value). Applying it to only one is how you get a codex-flavoured
        # options bundle handed to a claude process.
        worker_override = options.pop("worker_type", None)
        # Transport, not identity: a chat surface streams JSON, a one-shot run
        # prints. Goes through the constructor (see ``to_agent_options``).
        opts = agent.to_agent_options(worker_type=worker_override, output_format=options.pop("output_format", None))

        # The agent's system prompt goes in via ``context_data.instructions`` —
        # the ONE channel ``resolve_system_instructions`` reads, which
        # ``prepare_system_instruction_assets`` then materializes as CLAUDE.md /
        # AGENTS.md / .agents / copilot instructions and hands to the driver as
        # ``system_prompt_file`` + ``--add-dir``. Setting ``system_prompt_append``
        # directly would reach Claude only: codex takes ``developer_instructions``
        # and copilot ``custom_instruction_dirs``, and
        # ``_apply_system_instruction_assets`` nulls the append field anyway.
        context_data = {**(options.pop("context_data", None) or {})}
        if agent.system_prompt:
            existing = str(context_data.get("instructions") or "").strip()
            context_data["instructions"] = "\n\n".join(
                p for p in (agent.system_prompt.strip(), existing) if p
            )
        context_data.setdefault("launched_by_agent", agent.name)
        # Chief of Staff mode — CoS.md, the skill, the native staff roster. Off: nothing changes.
        from flow_sdk.tasks.cos import apply_to_launch, staff_dir  # noqa: PLC0415

        cli_config = opts.to_json()
        cos_options = apply_to_launch(
            agent, context_data=context_data, cli_config=cli_config, worker_type=worker_override or agent.worker_type,
            project_dir=await staff_dir(agent) if getattr(agent, "chief_of_staff", False) else None,
        )

        # Declared -> attached, BEFORE the folder is read below. ``mcp_servers``
        # on agent.json is the authored intent; ``mcp_assets()`` is the structural
        # attachment a launch resolves, and this is the one place that turns the
        # first into the second. Idempotent, so a re-launch of an unchanged
        # agent writes nothing.
        await agent.attach_declared_mcp_servers()

        # An agent acting in ANOTHER project's checkout still needs its own files: mount
        # its home and say where it is, so a path in its prompt resolves there.
        acting_project_id = options.pop("project_id", None) or agent.project_id
        additional_dirs = list(agent.additional_dirs or [])
        home = await _foreign_home(agent, acting_project_id)
        if home:
            if home not in additional_dirs:
                additional_dirs.append(home)
            context_data["instructions"] = "\n\n".join(
                p for p in (str(context_data.get("instructions") or "").strip(), home_line(home)) if p
            )

        process = AgenticProcess(
            name=options.pop("name", None) or f"{agent.name}: {prompt[:40]}",
            workdir=options.pop("workdir", None),
            visible=bool(options.pop("visible", False)),
            # Headless by default: pty_mode=False routes prompt() to the
            # print-mode driver, no PTY or Shell. Callers wanting the
            # interactive worker pass pty_mode=True and start it themselves.
            pty_mode=options.pop("pty_mode", False),
            process_type=options.pop("process_type", ProcessKind.EXECUTION.value),
            worker_type=worker_type_value(worker_override or agent.worker_type or await selected_worker_type()),
            project_id=acting_project_id,
            load_flowpad_assistant=cos_options.get("load_flowpad_assistant", agent.load_flowpad_assistant),
            additional_dirs=additional_dirs,
            # The agent's MCP assets, resolved from its folder. Set on the
            # constructor rather than via ``process.add_mcp`` because this verb
            # is documented "not saved" and ``add_mcp`` saves. A process may
            # still add its own on top; ``resolved_mcp_servers`` dedupes by name.
            # Reads the folder AFTER the attach above, which is what puts the
            # editor's declared ids there.
            mcp_servers=await _place_mcp_specs(agent, place_mcp),
            cli_config=cli_config,
            instruction_content=prompt,
            context_data=context_data,
            deployment_id=self.id,
            **options,
        )
        return process

    async def launch(
        self, prompt: str, *, wait: bool = False, input: Any = None, output_spec: Any = None, **options
    ) -> "PromptResult":
        """``create_process`` + save + run the first turn — answered as a
        ``PromptResult`` whose ``executor`` names the process. Never raises for
        an outcome.

        Without ``wait``, OK means the turn was ACCEPTED (it runs on in the
        background) — the answer ``send_turn`` gives. With ``wait=True`` it is
        the RUN's answer once the worker settles, read the way
        ``AgenticProcess.run`` reads it. Not taken is NOT_YET (``busy`` when a
        turn is in flight); a disabled agent is REFUSED, a missing one NOT_FOUND.
        A caller that needs the process resolves it from ``executor``.

        ``input`` / ``output_spec``: typed folder I/O — see ``process_io``; the agent's declared ``input`` /
        ``output`` apply when omitted, and the output is read back only with ``wait=True``.
        """
        from flow_sdk.builtin.agentic_process.process_io import (  # noqa: PLC0415
            check_declared_input,
            declared_output_spec,
            prepare_io,
            resolve_output_spec,
            take_turn,
        )

        agent = await self.agent()
        spec = resolve_output_spec(output_spec) or declared_output_spec(getattr(agent, "output", None))
        check_declared_input(input, getattr(agent, "input", None))
        try:
            proc = await self.create_process(prompt, **options)
        except AgentUnavailable as gone:
            return gone.answer()
        prepare_io(proc, input=input, output_spec=spec)
        await proc.save()
        return await take_turn(proc, prompt, spec, wait=wait)

    async def use(self, *, owner=None, **options) -> "AgenticProcess":
        """Open a session AS this agent: a visible, headless Chat process, saved,
        with no first turn — the human types it.

        The interactive counterpart of :meth:`launch`. Same bundle (worker,
        model, permissions, system prompt, dirs, ``deployment_id``); what
        differs is only the surface: ``process_type=chat`` and stream-json
        output so the vibe/chat pane can render it, keyed to the agent through
        ``target_typeid_str`` so "sessions of this agent" is one query.
        Always a NEW process — using an agent starts a fresh session as it.
        """
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

        # Same routing rule as ``run``: a session opens on the node the agent is
        # placed on. A remote placement is opened THROUGH THE HUB, which reaches
        # the machine and hands back a same-id process this tier adopts as a
        # route row (see ``_use_on_hub``); ``run`` still refuses it (see
        # ``agent_run.dispatch_agent_run``).
        if not self.is_local:
            return await self._use_on_hub(owner=owner)
        agent = await self._require_agent()  # ``create_process`` re-reads it from the memoized ``_element``
        # Peeked, not popped — ``create_process`` stays the one owner of the
        # caller-else-agent fallback. It is read here because the acting project
        # has to drive the WORKDIR too: resolving cwd from ``agent.project_id``
        # would open a help-desk agent's session inside the vendor's checkout
        # rather than the customer's project.
        workdir = options.pop("workdir", None)
        project_id = options.get("project_id") or agent.project_id
        if not workdir and project_id:
            project = await Project.get_by_id(project_id)
            workdir = getattr(project, "fs_storage_mount_path", None) if project else None
        proc = await self.create_process(
            "",
            name=options.pop("name", None) or agent.display_name,
            process_type=ProcessKind.CHAT.value,
            visible=True,
            pty_mode=False,
            output_format="stream-json",
            workdir=workdir,
            target_typeid_str=str(agent.typeid),
            **options,
        )
        await proc.save(owner)
        return proc

    async def _use_on_hub(self, *, owner=None) -> "AgenticProcess":
        """Open a session on this REMOTE placement through the hub, and adopt the
        process it minted as a route row. The hub refuses a placement it never
        made — a cloud row minted locally has no counterpart there."""
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

        agent = await self._require_agent()
        opened = await hub_http.hub_post(agent.get_type(), {"deployment_id": self.id}, agent.id, "use")
        process_id = str((opened or {}).get("process_id") or "")
        if not is_valid_entity_id(process_id):
            raise RuntimeError("the hub returned an invalid process for this deployment")
        return await AgenticProcess.adopt_route(process_id=process_id, deployment=self, agent=agent, owner=owner)

    async def runs(self, limit: int = 50) -> list["AgenticProcess"]:
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

        # Bound and ordering go into the query, not a Python slice: a long-lived
        # deployment would otherwise hydrate every process it ever produced to
        # hand back `limit` of them — in arbitrary order.
        #
        # `match` must be explicit. QueryFilter.parse wraps a bare dict entirely
        # into `match`, so passing order_by/limit as top-level keys would turn
        # them into field predicates that match nothing.
        return await AgenticProcess.get_all({
            "match": {"deployment_id": self.id},
            "order_by": {"created_date": "desc"},
            "limit": limit,
        })

    # ── validators ────────────────────────────────────────────────────────

    @field_validator("artifact_id", mode="before")
    @classmethod
    def _valid_artifact_id(cls, value: Any) -> str | None:
        if value in (None, ""):
            return None
        candidate = str(value).strip()
        if not is_valid_entity_id(candidate):
            raise ValueError("artifact_id must be a UUID v4 or v5")
        return candidate

    @field_validator("provider_labels", mode="before")
    @classmethod
    def _string_provider_labels(cls, value: Any) -> dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("Deployment provider_labels must be an object")
        return {str(key): str(item) for key, item in value.items() if item is not None}

    @field_validator("observations")
    @classmethod
    def _temporal_observation_windows(
        cls,
        value: dict[DeploymentObservationKind, DeploymentObservation],
    ) -> dict[DeploymentObservationKind, DeploymentObservation]:
        for kind in (DeploymentObservationKind.COST, DeploymentObservationKind.ACTIVITY):
            observation = value.get(kind)
            if observation and (observation.window_start is None or observation.window_end is None):
                raise ValueError(f"{kind.value} observation requires a declared window")
        return value


def _local_node_typeid() -> str:
    """This computer's ComputeNode, by its deterministic id — pure, no DB read (``compute_node_id`` rule)."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    return f"{EntityType.COMPUTE_NODE.value}-{ComputeNode._local_id()}"


__all__ = ["NODE_PROVIDERS", "Deployment", "DeploymentIdentity"]


def home_line(home: str) -> str:
    """The one sentence that tells an agent where its own files are."""
    return f"Your own files are in {home}; paths in your instructions are relative to it."


async def _foreign_home(agent, acting_project_id: str | None) -> str | None:
    """The agent's own folder when it lies outside the acting project's folder, else ``None``.

    ``agent.home()`` knows a project's folder or a repository. An agent in a plain
    dependency folder (no git, not a project of its own) has neither — but the acting
    project depends on that folder, so the deepest of its dependency roots holding the
    agent IS its home."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under  # noqa: PLC0415

    acting = await Project.get_by_id(acting_project_id) if acting_project_id else None
    mount = getattr(acting, "fs_storage_mount_path", None)
    home = await agent.home()
    if not home and acting is not None and agent.asset_ref:
        try:
            ref = canonical_posix_path(agent.asset_ref)
        except OSError:
            ref = ""
        holding = [r for r in acting.direct_context_roots()[1:] if ref and is_path_under(ref, r)]
        home = max(holding, key=len) if holding else None
    if not home:
        return None
    if mount and is_path_under(home, canonical_posix_path(mount)):
        return None
    return home

