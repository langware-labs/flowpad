"""AgentDeployment — a typed facade over ``Deployment``, not a new entity type.

``Deployment`` is already the provider-neutral placement record
(``kind`` / ``target`` / ``resource`` / ``status`` / ``provider_labels``), and a
``local`` kind already ships: ``agentic_process.py`` upserts
``kind="local.runtime.web"`` with ``target.provider="local"`` for a locally-run
webapp. An agent deployment is the same record with
``kind="local.runtime.agent"`` — which is why this module adds behaviour, not
schema, and why agent deployments get WorldView projection and cloud reconcile
for free.

The Agent is the deployment's ``parent_type_id`` (``Deployment``'s documented
"provider hierarchy uses the inherited parent_type_id").

Local deployments never leave the machine: they describe THIS host, so they are
not hub-shareable.
"""
from typing import TYPE_CHECKING, Optional

from flow_sdk._compat import UTC
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.deployment import Deployment

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agentic_process import AgenticProcess

LOCAL_DEPLOYMENT_KIND = "local.runtime.agent"

#: Which machine the deployment places the agent on. A provider label rather
#: than a field, matching how the shipped webapp deployment carries
#: `flowpad.runtime.port` — Deployment stays provider-neutral.
COMPUTE_NODE_LABEL = "flowpad.compute.node_id"


def _deployment_id_for(agent_id: str, kind: str) -> str:
    """Deterministic id so deploy() is idempotent per (agent, kind).

    Mirrors the shipped webapp deployment, which mints
    ``deployment:legacy-artifact:<artifact id>`` for the same reason.
    """
    return mint_uuid(f"deployment:agent:{agent_id}:{kind}")


class AgentDeployment:
    """Behavioural facade WRAPPING a ``Deployment`` row — not a subclass.

    ``SchemaRegistry`` enforces one entity class per type name, so subclassing
    ``Deployment`` would collide on ``"deployment"``. Wrapping keeps the promise
    that an agent deployment IS an ordinary Deployment row (and so inherits
    WorldView projection and cloud reconcile) while giving the launch behaviour
    a home. Attribute reads fall through to the row.
    """

    def __init__(self, deployment: Deployment, agent: Optional["Agent"] = None) -> None:
        self.deployment = deployment
        # The Agent this was built from, when we already have it. Not just a
        # cache: a shipped agent resolved off disk on a cold instance is never
        # persisted, so re-reading it back by parent_type_id would find nothing.
        self._agent = agent

    def __getattr__(self, item):  # id / kind / target / status / … from the row
        return getattr(self.deployment, item)

    # `typeid` is NOT redeclared — __getattr__ forwards it, since this class
    # defines no attribute of that name for normal lookup to find.

    # ── construction ──────────────────────────────────────────────────────

    @classmethod
    async def upsert_for(cls, agent: "Agent", *, kind: str = LOCAL_DEPLOYMENT_KIND) -> "AgentDeployment":
        from datetime import datetime  # noqa: PLC0415

        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        # The local kind is, by definition, this machine. Other kinds will pass
        # their own node when they land; the label is the seam either way.
        node_id = ComputeNode._local_id()
        dep_id = _deployment_id_for(agent.id, kind)
        existing = await Deployment.get_by_id(dep_id)
        machine = get_instance_settings().instance_name
        payload = {
            "name": f"{agent.name or agent.id} ({kind.split('.')[0]})",
            "kind": kind,
            "target": {"provider": "local", "scope": agent.project_id or "machine", "location": machine},
            "resource": {
                "full_resource_name": f"local://{machine}/agent/{agent.name or agent.id}",
                "asset_type": "flowpad.local/Agent",
            },
            "status": {"sync_state": "current", "provider_state": "configured"},
            "provider_labels": {
                COMPUTE_NODE_LABEL: node_id,
                "flowpad.agent.name": str(agent.name or ""),
                "flowpad.agent.worker": str(agent.worker_type or ""),
                "flowpad.agent.model": str(agent.model or ""),
            },
            "project_id": agent.project_id,
            "parent_type_id": str(agent.typeid),
        }
        if existing is None:
            payload["status"]["observed_at"] = datetime.now(UTC).isoformat()
            dep = Deployment(id=dep_id, **payload)
            await dep.save()
            return cls(dep, agent)

        # Resolving an agent happens on EVERY launch, so this must be a real
        # no-op when nothing changed. It previously stamped `observed_at` into
        # the payload unconditionally, which made the row dirty every time —
        # costing a SQL UPDATE, a WS broadcast to every client, and three
        # metadata.json touches per launch for a timestamp nobody reads.
        # `observed_at` belongs to whatever actually OBSERVES the deployment
        # (reconcile), not to looking one up.
        if any(getattr(existing, field, None) != value for field, value in payload.items()):
            existing.apply_field_updates(payload)
            await existing.save()
        return cls(existing, agent)

    @classmethod
    async def for_agent(cls, agent: "Agent") -> list["AgentDeployment"]:
        rows = await Deployment.get_all({"parent_type_id": str(agent.typeid)})
        return [cls(r) for r in rows if str(r.kind or "").endswith(".agent")]

    @property
    def compute_node_id(self) -> str:
        """The machine this deployment places the agent on.

        THE addressing seam. A run is not "execute here" — it is "execute on
        the node this deployment is placed on", which is what lets the same
        call mean a local spawn today and a message to a remote node's event
        bus later. Carried in ``provider_labels`` the way the shipped webapp
        deployment carries ``flowpad.runtime.port``.

        Falls back to the deterministic ``@local`` id (pure — no DB read, no
        mint side-effect, same reason ``node_on_tag`` uses it) so an older row
        written before the label existed still resolves.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        label = (self.provider_labels or {}).get(COMPUTE_NODE_LABEL)
        return str(label) if label else ComputeNode._local_id()

    @property
    def is_local(self) -> bool:
        """Whether this deployment runs on the machine we are executing on."""
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        return self.compute_node_id == ComputeNode._local_id()

    async def agent(self) -> Optional["Agent"]:
        from flow_sdk.api.type_id import TypeId  # noqa: PLC0415
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

        if self._agent is not None:
            return self._agent
        if not self.parent_type_id:
            return None
        # TypeId has no .parse — the constructor does the parsing.
        return await Agent.get_by_id(TypeId(str(self.parent_type_id)).id)

    # ── the one launch verb ───────────────────────────────────────────────

    async def build(self, prompt: str = "", **options) -> "AgenticProcess":
        """Project this agent onto an AgenticProcess. Not saved, not started.

        The primitive. Every field the agent declares (worker, model,
        permissions, system prompt) comes from the Agent; only per-run concerns
        (``visible``, ``process_type``, ``target_typeid_str``, ``context_data``,
        ``workdir``, ``pty_mode``, …) are accepted here and passed through.

        This is a separate verb rather than a pair of ``launch`` flags because
        most callers genuinely want only this half: they own the save (to add
        ``notify``/``owner``), or the start (to attach a Shell, schedule the
        first turn, or drive the turns themselves), or neither -- `flow diagnose`
        and the migration runner both spawn from a process that is never
        persisted at all.
        """
        from flow_sdk.builtin.agent import worker_type_value  # noqa: PLC0415
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

        agent = await self.agent()
        if agent is None:
            raise RuntimeError(f"deployment {self.id}: agent {self.parent_type_id!r} not found")
        if not agent.enabled:
            raise RuntimeError(f"agent {agent.name!r} is disabled")

        # A per-run worker override has to reach BOTH sides — the options object
        # (dispatched on the driver key) and the process field (a WorkerType
        # enum value). Applying it to only one is how you get a codex-flavoured
        # options bundle handed to a claude process.
        worker_override = options.pop("worker_type", None)
        opts = agent.to_agent_options(worker_type=worker_override)

        # The agent's system prompt goes in via ``context_data.instructions`` —
        # the ONE channel ``resolve_system_instructions`` reads, which
        # ``prepare_system_instruction_assets`` then materializes as CLAUDE.md /
        # AGENTS.md / .agents / copilot instructions and hands to the driver as
        # ``system_prompt_file`` + ``--add-dir``. Setting ``system_prompt_append``
        # directly would reach Claude only: codex takes
        # ``developer_instructions`` and copilot ``custom_instruction_dirs``, and
        # ``_apply_system_instruction_assets`` nulls the append field anyway.
        context_data = {**(options.pop("context_data", None) or {})}
        if agent.system_prompt:
            existing = str(context_data.get("instructions") or "").strip()
            context_data["instructions"] = "\n\n".join(
                p for p in (agent.system_prompt.strip(), existing) if p
            )
        context_data.setdefault("launched_by_agent", agent.name)

        return AgenticProcess(
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
            cli_config=opts.to_json(),
            instruction_content=prompt,
            context_data=context_data,
            deployment_id=self.id,
            **options,
        )

    async def launch(self, prompt: str, *, wait: bool = False, **options) -> "AgenticProcess":
        """``build`` + save + run the first turn. The convenience shape.

        ``wait=True`` polls to a terminal state.
        """
        from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

        proc = await self.build(prompt, **options)
        await proc.save()
        resp = await proc.prompt(prompt)
        if isinstance(resp, ApiFailResponse):
            raise RuntimeError(f"launch failed — {resp.message}")
        if wait:
            await proc.wait()
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
