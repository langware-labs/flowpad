"""A help desk's optional agents, set up from the desk's own page.

POST /api/v1/graph/helpdesk-agents  {desk_project_id}           — the desk's agents on this machine, by side
POST /api/v1/graph/helpdesk-agent   {HelpdeskAgent fields}       — make one: its project, the agent, its help-desk
                                                                   source (which says the side and when it replies),
                                                                   and its loop running on this computer

A desk agent is an ordinary agent that owns the desk's ``helpdesk`` source: the source's config is where the side,
the reply events and moderation live, so the driver alone decides where the agent's words go. Each one is the main
agent of a project of its own -- a project has one local deployment with one main agent, so a desk's two agents
could not both answer from one project.
"""

from __future__ import annotations

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.helpdesk_agent_spec import HelpdeskAgent, HelpdeskAgentSide

PROVIDER = "helpdesk"

#: What each side's agent does when the owner writes nothing of their own.
DEFAULT_INSTRUCTIONS = {
    HelpdeskAgentSide.CUSTOMER: (
        "You answer customers of this help desk. Make sure the team has everything it needs from the customer: "
        "what they tried, what they expected, what happened, and any error text. Ask for what is missing, one "
        "short question at a time. Never promise a fix."
    ),
    HelpdeskAgentSide.TEAM: (
        "You help this help desk's team. For each ticket, write a first root-cause analysis for a team member to "
        "review: the likely cause, the evidence for it, and the next check. You write to the team only."
    ),
}

NAMES = {HelpdeskAgentSide.CUSTOMER: "customer agent", HelpdeskAgentSide.TEAM: "team agent"}


async def _body() -> dict:
    request_info = get_current_request_info()
    return (await request_info.get_post_data() or {}) if request_info else {}


async def desk_agents(desk_project_id: str) -> list[HelpdeskAgent]:
    """The agents that own a source on this desk, one per side at most (the first found wins)."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

    found: dict[HelpdeskAgentSide, HelpdeskAgent] = {}
    for source in await DataSource.get_all({"provider": PROVIDER}):
        config = source.config or {}
        desk = config.get("desk_project_id")
        if (desk.get("id") if isinstance(desk, dict) else desk) != desk_project_id:
            continue
        owner = await owner_of(source)
        if owner is None or owner.type != "agent":
            continue
        agent = await Agent.get_by_id(owner.id)
        side = HelpdeskAgentSide(config.get("side") or HelpdeskAgentSide.CUSTOMER.value)
        if agent is None or side in found:
            continue
        found[side] = HelpdeskAgent(
            desk_project_id=desk_project_id,
            side=side,
            reply_not_picked_up=bool(config.get("reply_not_picked_up", True)),
            reply_tagged=bool(config.get("reply_tagged", True)),
            moderated=bool(config.get("moderated", False)),  # as the driver reads it: nothing waits unless stated
            agent_id=str(agent.id),
            agent_name=agent.name,
        )
    return list(found.values())


async def _project_for(name: str, someone=None):
    """The agent's own project: a folder in the workspace, found again by its path."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.config import StorageProvider, agent_workspace_root  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.sources.files import safe_name  # noqa: PLC0415

    folder = agent_workspace_root() / "Help desk agents" / safe_name(name, fallback="Help desk agent")
    folder.mkdir(parents=True, exist_ok=True)
    canonical = canonical_posix_path(str(folder))
    project = await Project.find_by_cwd(canonical)
    if project is None:
        project = Project(
            type="project",
            name=await Project.free_name(name),
            fs_storage_mount_path=canonical,
            fs_storage_provider=StorageProvider.LOCAL.value,
        )
        await project.save(someone)
    return project


async def create_desk_agent(spec: HelpdeskAgent, desk_name: str, someone=None) -> HelpdeskAgent:
    """Its project, the agent, its source on the desk (saying the side and when it replies), and its loop."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded(PROVIDER)
    if driver is None:
        raise LookupError("the help desk driver is not installed")
    name = f"{desk_name or 'Help desk'} {NAMES[spec.side]}"
    # Validated before anything is written: a refused config leaves no agent or project behind.
    config = driver.create_config(
        desk_project_id=spec.desk_project_id,
        side=spec.side.value,
        reply_not_picked_up=spec.reply_not_picked_up,
        reply_tagged=spec.reply_tagged,
        moderated=spec.moderated,
    )
    project = await _project_for(name, someone)
    agent = await Agent(
        name=name,
        system_prompt=spec.instructions.strip() or DEFAULT_INSTRUCTIONS[spec.side],
        project_id=str(project.id),
    ).save()
    await driver.create_source(config, name=name, owner=agent).save()
    await agent.run_locally()
    return spec.model_copy(update={"agent_id": str(agent.id), "agent_name": agent.name})


@action.post(action_name="helpdesk-agents", types=None)
async def helpdesk_agents() -> ApiResponse:
    desk = str((await _body()).get("desk_project_id") or "").strip()
    if not desk:
        return ApiFailResponse(message="desk_project_id is required", status_code=400)
    return ApiSuccessResponse(data=[a.model_dump(mode="json") for a in await desk_agents(desk)])


@action.post(action_name="helpdesk-agent", types=None)
async def helpdesk_agent() -> ApiResponse:
    body = await _body()
    try:
        spec = HelpdeskAgent.model_validate({k: v for k, v in body.items() if k != "desk_name"})
    except ValueError as e:
        return ApiFailResponse(message=str(e), status_code=400)
    if any(a.side == spec.side for a in await desk_agents(spec.desk_project_id)):
        return ApiFailResponse(message=f"this desk already has a {NAMES[spec.side]}", status_code=409)
    try:
        request_info = get_current_request_info()
        someone = request_info.someone_typeid if request_info else None
        made = await create_desk_agent(spec, str(body.get("desk_name") or ""), someone)
    except (LookupError, ValueError) as e:
        return ApiFailResponse(message=str(e), status_code=400)
    return ApiSuccessResponse(data=made.model_dump(mode="json"))
