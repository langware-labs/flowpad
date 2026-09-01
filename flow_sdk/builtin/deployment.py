"""Deployment — the one placement record: this thing runs on that machine.

Every placement is this entity, whatever is placed and wherever it lands:

    Agent      → a sandbox of its own            (kind ``runtime.agent``)
    MicroApp   → a dev server, or a sandbox      (kind ``runtime.web``)
    ComputeNode→ a desktop                       (kind ``compute.node``)
    GCP/AWS/…  → an inventoried cloud resource   (kind ``gcp.*``)

Two axes, each declared exactly once:

* ``kind``            — WHAT is placed.
* ``target.provider`` — WHERE it runs: ``local``, ``e2b``, ``gcp``, ``aws``, …
  A provider is a *type of deployment*, never a parent of anything.

They used to be one field (``local.runtime.web``), which meant three call sites
asked the same question three different ways — ``kind_matches("local.runtime.
web", …)``, ``target.provider == "gcp"``, and ``kind.endswith(".agent")``.

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

from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional

from pydantic import PrivateAttr, field_validator

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin
from flow_sdk.core import Entity, action
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.models import (
    ArtifactLinkSource,
    DeploymentObservation,
    DeploymentObservationKind,
    DeploymentStatus,
    DeploymentTarget,
)
from flow_sdk.worldview.ontology import KindStr, normalize_kind

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agentic_process import AgenticProcess

#: What is placed. The ``compute.node`` kind is a desktop — a machine placed for
#: a human rather than for an agent; from inside the box the two are identical
#: (same template, same app), which is why they are one entity and not two.
KIND_AGENT = "runtime.agent"
KIND_WEB = "runtime.web"
KIND_NODE = "compute.node"

#: Providers that place a resource on a ComputeNode, so ``origin.external_id``
#: names that node. An inventoried ``gcp`` resource is not node-backed — its
#: ``external_id`` is the provider's own resource name.
NODE_PROVIDERS = frozenset({"local", "e2b", "user_machine"})


class Deployment(Entity):
    """A provider-neutral placement and observation record."""

    type: str = APIField(default=EntityType.DEPLOYMENT.value)
    name: str = APIField(description="Display name")
    kind: KindStr = APIField(description="Open dot-path ontology kind — WHAT is placed")
    artifact_id: str | None = APIField(default=None, description="Referenced Artifact (not the parent)")
    artifact_link_source: ArtifactLinkSource | None = APIField(default=None)
    target: DeploymentTarget = APIField(description="Provider placement target — WHERE it runs")
    # PRIVATE: for a provider in ``NODE_PROVIDERS`` this `external_id` names a
    # LOCAL ComputeNode, so the field is only conditionally transportable — and a
    # per-field policy cannot say "sometimes". Nothing reads it on a receiver
    # (the only consumer is the local WorldView projection), so the safe answer
    # is also the free one.
    origin: CloudOrigin | None = APIField(
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

    #: The deployed element, when the caller already had it. Not just a cache: a
    #: SHIPPED agent resolved off disk on a cold instance is never persisted, so
    #: reading it back by ``parent_type_id`` would find nothing at all.
    _element: Optional[Entity] = PrivateAttr(default=None)

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    def with_element(self, element: Optional[Entity]) -> "Deployment":
        """Attach the already-loaded deployed element. Returns self, for chaining."""
        self._element = element
        return self

    # ── convergence ───────────────────────────────────────────────────────

    @classmethod
    async def find_existing(
        cls,
        parent_type_id: str,
        provider: str,
        *,
        kind: str | None = None,
    ) -> Optional["Deployment"]:
        """The placement of *parent_type_id* on *provider*, or None.

        THE idempotency seam. Re-deploying converges here rather than on a
        derived id: an id is a name, not a fact about the thing, and a key baked
        into one can never change afterwards. Same shape as
        ``SourceItem.find_existing`` / ``DataSource.find_for_account``.

        ``target.provider`` lives inside a JSON column, so it is matched in
        Python rather than in the query — a nested-JSON predicate is not a
        supported filter, and the row count per element is tiny.
        """
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        rows = await cls.get_all({"match": {"parent_type_id": str(parent_type_id)}})
        wanted = str(provider).strip()
        for row in rows:
            if row.target.provider != wanted:
                continue
            # Exact-or-DESCENDANT, never equality: the ontology is hierarchical,
            # so a row refined to `runtime.web.vite` is still the web runtime of
            # this element. Matching on equality forked a second row the moment
            # anything specialized the kind.
            if kind is not None and not kind_matches(kind, row.kind):
                continue
            return row
        return None

    @classmethod
    async def upsert(
        cls,
        *,
        parent_type_id: str,
        provider: str,
        kind: str,
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
        body = {**payload, "kind": normalize_kind(kind), "parent_type_id": str(parent_type_id)}
        existing = await cls.find_existing(parent_type_id, provider, kind=kind)
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
        deployment = cls(**payload)
        deployment.remote = True
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
            return external
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

    @property
    def runtime_port(self) -> int | None:
        """The local dev-server port this placement runs on, if any.

        Owned here because callers kept re-deriving it from the raw label —
        parse, swallow ValueError, sometimes range-check, sometimes not. A junk
        label now reads as "no port" everywhere instead of only where someone
        remembered to guard.
        """
        raw = (self.provider_labels or {}).get("flowpad.runtime.port")
        try:
            port = int(str(raw))
        except (TypeError, ValueError):
            return None
        return port if 0 < port <= 65535 else None

    @property
    def host_url(self) -> str | None:
        """Where a human reaches this placement, if it is reachable at all."""
        return (self.origin.url if self.origin else None) or self.target.location

    async def element(self) -> Optional[Entity]:
        """The entity this places — the parent. Agent, MicroApp, ComputeNode…

        Resolved through the registry rather than a per-kind ``if`` ladder, so a
        new deployable element needs no change here. ``TypeId`` has no
        ``.parse`` — the constructor does the parsing.
        """
        from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

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
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        if self.remote:
            return await self._pause_on_hub()

        node_id = self.compute_node_id
        if node_id is None:
            return False
        node = await ComputeNode.get_by_id(node_id)
        if node is None:
            return False
        await node.pause()
        self.status = DeploymentStatus(
            sync_state=self.status.sync_state,
            provider_state="paused",
            observed_at=datetime.now(UTC).isoformat(),
            message=self.status.message,
        )
        await self.save()
        return True

    async def _pause_on_hub(self) -> bool:
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required to pause a cloud deployment")
        path = build_hub_url(self, action="pause")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            await client.post(path, {})
        return True

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

    # ── the launch verbs (agent placements) ───────────────────────────────

    async def agent(self) -> Optional["Agent"]:
        """The Agent this places, when it places one."""
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

        element = await self.element()
        return element if isinstance(element, Agent) else None

    async def _require_agent(self) -> "Agent":
        """The placed Agent, or a loud error — a launch site naming a missing or
        disabled agent is a bug we want to see, not a silent no-op."""
        agent = await self.agent()
        if agent is None:
            raise RuntimeError(f"deployment {self.id}: agent {self.parent_type_id!r} not found")
        if not agent.enabled:
            raise RuntimeError(f"agent {agent.name!r} is disabled")
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
        from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

        agent = await self._require_agent()

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

        # Declared -> attached, BEFORE the folder is read below. ``mcp_servers``
        # on agent.md is the authored intent; ``mcp_assets()`` is the structural
        # attachment a launch resolves, and this is the one place that turns the
        # first into the second. Idempotent, so a re-launch of an unchanged
        # agent writes nothing.
        await agent.attach_declared_mcp_servers()

        process = AgenticProcess(
            name=options.pop("name", None) or f"{agent.name}: {prompt[:40]}",
            workdir=options.pop("workdir", None),
            visible=bool(options.pop("visible", False)),
            # Headless by default: pty_mode=False routes prompt() to the
            # print-mode driver, no PTY or Shell. Callers wanting the
            # interactive worker pass pty_mode=True and start it themselves.
            pty_mode=options.pop("pty_mode", False),
            process_type=options.pop("process_type", ProcessKind.EXECUTION.value),
            worker_type=worker_type_value(worker_override or agent.worker_type),
            project_id=options.pop("project_id", None) or agent.project_id,
            load_flowpad_assistant=agent.load_flowpad_assistant,
            additional_dirs=list(agent.additional_dirs or []),
            # The agent's MCP assets, resolved from its folder. Set on the
            # constructor rather than via ``process.add_mcp`` because this verb
            # is documented "not saved" and ``add_mcp`` saves. A process may
            # still add its own on top; ``resolved_mcp_servers`` dedupes by name.
            # Reads the folder AFTER the attach above, which is what puts the
            # editor's declared ids there.
            mcp_servers=await agent.resolved_mcp_specs(),
            cli_config=opts.to_json(),
            instruction_content=prompt,
            context_data=context_data,
            deployment_id=self.id,
            **options,
        )
        _prepare_output_folder(process)
        return process

    async def launch(self, prompt: str, *, wait: bool = False, **options) -> "AgenticProcess":
        """``create_process`` + save + run the first turn. The convenience shape.

        ``wait=True`` polls to a terminal state.
        """
        from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

        proc = await self.create_process(prompt, **options)
        await proc.save()
        resp = await proc.prompt(prompt)
        if isinstance(resp, ApiFailResponse):
            raise RuntimeError(f"launch failed — {resp.message}")
        if wait:
            await proc.wait()
        return proc

    async def use(self, **options) -> "AgenticProcess":
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
        # placed on, and a remote placement is refused rather than quietly
        # opened here (see ``agent_run.dispatch_agent_run``).
        if not self.is_local:
            raise NotImplementedError(
                f"this agent is deployed on compute node {self.compute_node_id}, "
                "which cannot be reached from here yet."
            )
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
        await proc.save()
        return proc

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


def _prepare_output_folder(process: "AgenticProcess") -> None:
    """Give a non-flow run the same output convention a flow node gets.

    The FOLDER is already universal — every process serializes
    ``<record>/execution/{input,output,assets}``. What was flow-only is the
    CONVENTION: only ``_agent_instruction`` ever told an agent that an output
    folder exists, so a run launched from an Agent produced artifacts nowhere
    and the runs UI showed "no files" for it.

    Two lines, mirroring the flow engine: materialize the folder before the run
    (the id is minted at construction, so the path is known pre-save), and say
    where it is. Best-effort — a read-only disk must not fail the launch.
    """
    try:
        output = process._record_dir() / "execution" / "output"
        output.mkdir(parents=True, exist_ok=True)
    except Exception:  # noqa: BLE001
        return
    existing = str(process.context_data.get("instructions") or "").strip()
    line = (
        f"Write any files you produce to: `{output}/`\n"
        "Anything left there is collected as this run's output and shown in the UI."
    )
    process.context_data["instructions"] = "\n\n".join(p for p in (existing, line) if p)


__all__ = ["KIND_AGENT", "KIND_NODE", "KIND_WEB", "NODE_PROVIDERS", "Deployment"]
