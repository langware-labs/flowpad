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

#: The only deployment kind phase 1 ships — run it on this machine. Owned by
#: agent_deployment (which mints the deployment id from it); two literals that
#: must match are one too many.
from flow_sdk.builtin.agent_deployment import LOCAL_DEPLOYMENT_KIND
from flow_sdk.core import Entity, action
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent_deployment import AgentDeployment
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions

#: The two vocabularies for "which CLI".
#:
#: An agent.md declares the DRIVER short-id — that is what a human writes, what
#: the CLI is called, and the key ``cli_drivers.factory`` dispatches on. But
#: ``AgenticProcess.worker_type`` is a ``WorkerType``, whose Claude member is
#: ``claude_code``. Feed one where the other is expected and the process fails
#: pydantic validation, which is exactly what a real launch found.
#:
#: The forward direction is NOT redefined here: ``get_driver`` already owns that
#: alias table, and owns it better — it also handles ``claude_code_cli``, a
#: ``WorkerType`` object, casing, and the ``FLOWPAD_DEFAULT_WORKER`` default.
#: A private copy would be the fourth in the tree and would silently ignore that
#: env override.
_DRIVER_TO_WORKER = {"claude": "claude_code", "codex": "codex", "copilot": "copilot"}


def driver_key(worker: str | None) -> str:
    """The ``cli_drivers.factory`` key for either vocabulary."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        get_driver,
    )

    # A blank `worker_type:` in an agent.md means "unset", but get_driver only
    # treats None as unset and would raise on "". Normalize before handing over.
    return get_driver((worker or "").strip() or None).name


def worker_type_value(worker: str | None) -> str:
    """The ``AgenticProcess.worker_type`` enum value for either vocabulary.

    No production helper does this direction — only test-local copies — so it
    lives here, derived from ``driver_key`` so the two can't disagree.
    """
    key = driver_key(worker)
    return _DRIVER_TO_WORKER.get(key, key)


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
        description="SubAgent NAMES this agent may delegate to. Names, not TypeIds, because a "
        "shipped agent.md is authored before the SubAgent it references has ever been indexed. "
        "DECLARED ONLY — nothing projects these into --agents yet; wire through "
        "AgenticProcess.load_embedded_agent(name) when a caller needs it.",
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

    # ── the run verb (HTTP) ───────────────────────────────────────────────

    @action.post(action_name="run")
    async def run_action(self):
        """Run this agent once. `POST /agent/<id>/run  {"prompt": "..."}`

        The UI's entry point. Deliberately a command that ACKNOWLEDGES rather
        than a bare bus emission: the caller needs the process id to navigate
        to the run, and a fire-and-forget emit with no registered handler would
        be a silent no-op. The lifecycle is emitted as node-addressed events
        alongside — see ``agent_run.dispatch_agent_run``, which owns the
        local/remote routing.
        """
        from flow_sdk.builtin.agent_run import dispatch_agent_run  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        prompt = str((body or {}).get("prompt") or "").strip()
        if not prompt:
            return ApiFailResponse(message="prompt is required")
        if not self.enabled:
            return ApiFailResponse(message=f"agent {self.name!r} is disabled")

        deployment = await self.local_deployment()
        try:
            process = await dispatch_agent_run(deployment, prompt)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc))
        except Exception as exc:
            return ApiFailResponse(message=f"run failed: {exc}")

        return ApiSuccessResponse(
            data={
                "process_id": process.id,
                "process_typeid": str(process.typeid),
                "deployment_id": deployment.id,
                "compute_node_id": deployment.compute_node_id,
            }
        )

    # ── projection into the launch bundle ─────────────────────────────────

    def to_agent_options(self, worker_type: Optional[str] = None) -> "AgentOptions":
        """Build the vendor options object this agent launches with.

        Only ever sets keys that already exist in ``to_json()`` — the serialized
        shape must stay byte-identical, because ``last_started_hash`` is an md5
        over it and any new/renamed key would flip ``restart_required`` on every
        running process. ``system_prompt`` deliberately does NOT appear here: it
        travels via ``context_data.instructions`` (see ``AgentDeployment.launch``).

        ``additional_dirs`` is deliberately absent too: both drivers overwrite
        ``cmd.add_dirs`` with ``AgenticProcess.resolved_add_dirs`` at spawn, so a
        copy here would be dead on arrival AND would perturb the very hash this
        docstring is protecting. The process field is the single source.
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import factory  # noqa: PLC0415

        # Vendor extras first, so a named field always wins over a free-form key
        # of the same name.
        cli_json: dict = dict(self.cli_options or {})
        for key, value in (
            ("model", self.model),
            ("permission_mode", self.permission_mode),
            ("effort", self.effort),
        ):
            if value is not None:
                cli_json[key] = value

        return factory(cli_json, driver_key(worker_type or self.worker_type))
