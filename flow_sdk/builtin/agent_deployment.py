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

    def __init__(self, deployment: Deployment) -> None:
        self.deployment = deployment

    def __getattr__(self, item):  # id / kind / target / status / … from the row
        return getattr(self.deployment, item)

    @property
    def typeid(self):
        return self.deployment.typeid

    # ── construction ──────────────────────────────────────────────────────

    @classmethod
    async def upsert_for(cls, agent: "Agent", *, kind: str = LOCAL_DEPLOYMENT_KIND) -> "AgentDeployment":
        from datetime import datetime  # noqa: PLC0415

        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

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
            "status": {
                "sync_state": "current",
                "provider_state": "configured",
                "observed_at": datetime.now(UTC).isoformat(),
            },
            "provider_labels": {
                "flowpad.agent.name": str(agent.name or ""),
                "flowpad.agent.worker": str(agent.worker_type or ""),
                "flowpad.agent.model": str(agent.model or ""),
            },
            "project_id": agent.project_id,
            "parent_type_id": str(agent.typeid),
        }
        if existing is None:
            dep = Deployment(id=dep_id, **payload)
        else:
            dep = existing
            dep.apply_field_updates(payload)
        await dep.save()
        return cls(dep)

    @classmethod
    async def for_agent(cls, agent: "Agent") -> list["AgentDeployment"]:
        rows = await Deployment.get_all({"parent_type_id": str(agent.typeid)})
        return [cls(r) for r in rows if str(r.kind or "").endswith(".agent")]

    async def agent(self) -> Optional["Agent"]:
        from flow_sdk.api.type_id import TypeId  # noqa: PLC0415
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

        if not self.parent_type_id:
            return None
        # TypeId has no .parse — the constructor does the parsing.
        return await Agent.get_by_id(TypeId(str(self.parent_type_id)).id)

    # ── the one launch verb ───────────────────────────────────────────────

    async def launch(
        self,
        prompt: str,
        *,
        pty: bool = False,
        wait: bool = False,
        start: bool = True,
        save: bool = True,
        **options,
    ) -> "AgenticProcess":
        """Run this agent once. Returns the process that records the run.

        Every field the agent declares (worker, model, permissions, dirs,
        system prompt) comes from the Agent; only per-run concerns
        (``visible``, ``process_type``, ``target_typeid_str``, ``context_data``,
        ``workdir``, …) are accepted here.

        Three start shapes, because the call sites genuinely differ:

        * ``pty=False`` (default) — headless one-shot: ``pty_mode=False`` routes
          ``prompt()`` to the print-mode driver, no PTY or Shell. This is what
          every internal agent wants.
        * ``pty=True`` — interactive: spawns the PTY worker, for a run a human
          will attach to.
        * ``start=False`` — create the row and stop, for callers that schedule
          the first turn themselves.

        ``wait=True`` polls to a terminal state and is only meaningful headless.

        ``save=False`` skips persisting the row. Two callers need this
        deliberately -- the migration runner and `flow diagnose` both spawn
        without a pre-saved record (the exist_in_db gate was dropped for
        visible=False precisely so they could), so persisting would change
        documented behaviour.
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.flowpad_types.enums import ProcessKind  # noqa: PLC0415

        agent = await self.agent()
        if agent is None:
            raise RuntimeError(f"deployment {self.id}: agent {self.parent_type_id!r} not found")
        if not agent.enabled:
            raise RuntimeError(f"agent {agent.name!r} is disabled")

        opts = agent.to_agent_options(worker_type=options.pop("worker_type", None))

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

        proc = AgenticProcess(
            name=options.pop("name", None) or f"{agent.name}: {prompt[:40]}",
            workdir=options.pop("workdir", None),
            visible=bool(options.pop("visible", False)),
            pty_mode=options.pop("pty_mode", pty),
            process_type=options.pop("process_type", ProcessKind.EXECUTION.value),
            worker_type=agent.worker_type,
            project_id=options.pop("project_id", None) or agent.project_id,
            load_flowpad_assistant=agent.load_flowpad_assistant,
            additional_dirs=list(agent.additional_dirs or []),
            cli_config=opts.to_json(),
            instruction_content=prompt,
            context_data=context_data,
            deployment_id=self.id,
            **options,
        )
        if save:
            await proc.save()
        if not start:
            return proc
        if pty:
            await proc.start_pty(instruction=prompt)
            return proc

        from flow_sdk.api.messages import ApiFailResponse  # noqa: PLC0415

        resp = await proc.prompt(prompt)
        if isinstance(resp, ApiFailResponse):
            raise RuntimeError(f"{agent.name}: launch failed — {resp.message}")
        if wait:
            await proc.wait()
        return proc

    async def run(self, event: dict, **options) -> "AgenticProcess":
        """Event-shaped alias for graph nodes and triggers."""
        prompt = str(event.get("prompt") or event.get("instruction") or "")
        return await self.launch(prompt, context_data={"event": event}, **options)

    async def runs(self, limit: int = 50) -> list["AgenticProcess"]:
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

        rows = await AgenticProcess.get_all({"deployment_id": self.id})
        return rows[:limit]
