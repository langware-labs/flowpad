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

#: The two vocabularies for "which CLI", and the map between them.
#:
#: An agent.md declares the DRIVER short-id — that is what a human writes, what
#: the CLI is called, and the key ``cli_drivers.factory`` dispatches on. But
#: ``AgenticProcess.worker_type`` is a ``WorkerType``, whose Claude member is
#: ``claude_code``. Feed one where the other is expected and the process fails
#: pydantic validation (or the factory raises "Unknown worker_type"), which is
#: exactly what a real launch found. Both directions live here so no call site
#: has to re-derive them; the long-test factory keeps the same mapping.
_DRIVER_TO_WORKER = {"claude": "claude_code", "codex": "codex", "copilot": "copilot"}
_WORKER_TO_DRIVER = {v: k for k, v in _DRIVER_TO_WORKER.items()}


def driver_key(worker: str | None) -> str:
    """The ``cli_drivers.factory`` key for either vocabulary. Default: claude."""
    raw = (worker or "claude").strip()
    return _WORKER_TO_DRIVER.get(raw, raw)


def worker_type_value(worker: str | None) -> str:
    """The ``AgenticProcess.worker_type`` enum value for either vocabulary."""
    raw = (worker or "claude").strip()
    return _DRIVER_TO_WORKER.get(raw, raw)


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
    subagents: list[str] = APIField(
        default_factory=list,
        description="SubAgent NAMES this agent may delegate to, resolved at launch and rendered "
        "into --agents. Names, not TypeIds, because a shipped agent.md is authored before the "
        "SubAgent it references has ever been indexed — and name is already the addressable "
        "identity (get_agent_local_deployment('asset-cleanup')).",
    )
    additional_dirs: list[str] = APIField(default_factory=list)
    load_flowpad_assistant: bool = APIField(default=False)
    cli_options: dict = APIField(
        default_factory=dict,
        description="Vendor-specific launch keys the schema does not enumerate (e.g. Claude's "
        "`chrome: true`). Merged into the options bundle under the named fields, so a "
        "capability an agent needs stays visible on its card instead of living at a call site.",
    )

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

    @property
    def resolved_worker_type(self) -> str:
        """This agent's ``worker_type`` as the enum value AgenticProcess stores."""
        return worker_type_value(self.worker_type)

    def to_agent_options(self, **overrides) -> "AgentOptions":
        """Build the vendor options object this agent launches with.

        Only ever sets keys that already exist in ``to_json()`` — the serialized
        shape must stay byte-identical, because ``last_started_hash`` is an md5
        over it and any new/renamed key would flip ``restart_required`` on every
        running process. ``system_prompt`` deliberately does NOT appear here: it
        travels via ``context_data.instructions`` (see ``AgentDeployment.launch``).
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import factory  # noqa: PLC0415

        worker = driver_key(overrides.pop("worker_type", None) or self.worker_type)
        # Vendor extras first, so a named field always wins over a free-form key
        # of the same name.
        cli_json: dict = dict(self.cli_options or {})
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
