"""Agent — the launchable agent: identity + launch bundle.

An Agent answers *who*; a ``Deployment`` answers *where and how*; an
``AgenticProcess`` records *what happened on one run*::

    Agent.deploy()            -> AgentDeployment   (a Deployment, kind local.runtime.agent)
    AgentDeployment.launch()  -> AgenticProcess

Folder layout (``AssetClass.REPO``, like Spec/Task/Deck)::

    <scope>/agentic-assets/agent/<name>/agent.md

The entity OWNS that file (``owns_main_ref``): ``system_prompt`` is the
authoring surface and the body is re-rendered on every save, so disk stays the
source of truth (``docs/CLAUDE.md`` §1) while the hub copy still carries the
prompt as a real field.

NOT the same thing as a ``SubAgent``: that is the provider-owned
``.claude/agents/<name>.md`` prompt asset Claude Code reads directly. An Agent
may *reference* SubAgents through ``subagents`` — they render to that path
verbatim and are never absorbed here.
"""
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent_deployment import AgentDeployment
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions

#: The only deployment kind phase 1 ships — run it on this machine.
LOCAL_DEPLOYMENT_KIND = "local.runtime.agent"


class Agent(Entity):
    type: str = APIField(default=EntityType.AGENT.value)

    # ── identity / presentation ───────────────────────────────────────────
    # `name` / `title` / `uname` come from Entity. `name` is the addressable
    # slug: get_agent_local_deployment("asset-cleanup") resolves on it.
    description: str = APIField(default="", description="One-line purpose, shown on the agent card.")
    avatar: Optional[str] = APIField(default=None, description="Emoji or image ref — presentation only.")
    system_prompt: str = APIField(
        default="",
        description="Who this agent is. Delivered through context_data.instructions — the channel "
        "resolve_system_instructions reads — so it reaches all three vendors and never enters "
        "cli_config, leaving the restart hash untouched.",
    )

    # ── launch bundle (projected into AgentOptions at launch) ─────────────
    worker_type: Optional[str] = APIField(default=None, description="claude | codex | copilot.")
    model: Optional[str] = APIField(default=None, description="Tier (sm/md/lg) or a concrete model id.")
    permission_mode: Optional[str] = APIField(default=None)
    effort: Optional[str] = APIField(default=None)
    max_turns: Optional[int] = APIField(default=None)
    # None is NOT [] — an omitted list inherits everything the harness allows,
    # an empty list revokes it. Normalizing one to the other silently changes
    # what the agent may do.
    tools: Optional[list[str]] = APIField(default=None)
    disallowed_tools: Optional[list[str]] = APIField(default=None)
    skills: list[TypeId] = APIField(default_factory=list)
    mcp_servers: list[TypeId] = APIField(default_factory=list)
    subagents: list[TypeId] = APIField(
        default_factory=list, description="SubAgent refs rendered into --agents at launch."
    )
    additional_dirs: list[str] = APIField(default_factory=list)
    load_flowpad_assistant: bool = APIField(default=False)

    # ── lifecycle ─────────────────────────────────────────────────────────
    enabled: bool = APIField(default=True, description="Kill switch — a disabled agent refuses to launch.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    # ── deployment ────────────────────────────────────────────────────────

    async def deploy(self, kind: str = LOCAL_DEPLOYMENT_KIND) -> "AgentDeployment":
        """Idempotent upsert of this agent's deployment for *kind*."""
        from flow_sdk.builtin.agent_deployment import AgentDeployment  # noqa: PLC0415

        return await AgentDeployment.upsert_for(self, kind=kind)

    async def local_deployment(self) -> "AgentDeployment":
        """Get-or-create the ``local`` deployment — run it on this machine.

        SDK-only by design: a local deployment describes THIS machine, so it is
        ``Sharing.PRIVATE`` and never reaches the hub.
        """
        return await self.deploy(LOCAL_DEPLOYMENT_KIND)

    async def deployments(self) -> list["AgentDeployment"]:
        from flow_sdk.builtin.agent_deployment import AgentDeployment  # noqa: PLC0415

        return await AgentDeployment.for_agent(self)

    # ── projection into the launch bundle ─────────────────────────────────

    def to_agent_options(self, **overrides) -> "AgentOptions":
        """Build the vendor options object this agent launches with.

        Only ever sets keys that already exist in ``to_json()`` — the serialized
        shape must stay byte-identical, because ``last_started_hash`` is an md5
        over it and any new/renamed key would flip ``restart_required`` on every
        running process. ``system_prompt`` deliberately does NOT appear here: it
        travels via ``context_data.instructions`` (see ``AgentDeployment.launch``).
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import factory  # noqa: PLC0415

        worker = overrides.pop("worker_type", None) or self.worker_type or "claude"
        cli_json: dict = {}
        for key, value in (
            ("model", self.model),
            ("permission_mode", self.permission_mode),
            ("effort", self.effort),
            ("add_dirs", list(self.additional_dirs or []) or None),
        ):
            if value is not None:
                cli_json[key] = value
        cli_json.update({k: v for k, v in overrides.items() if v is not None})

        return factory(cli_json, worker)
