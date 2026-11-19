"""A help desk's optional agents, set up from the desk's own page.

POST /api/v1/graph/helpdesk-agents  {desk_project_id}           — the desk's agents on this machine, by side
POST /api/v1/graph/helpdesk-agent   {HelpdeskAgent fields}       — make one: its project, the agent, its source on the
                                                                   desk, and its loop running on this computer

A desk agent is an ordinary agent that owns a source on the desk: the support agent (customer side) the desk's
``helpdesk`` source, the internal agent (team side) the ``flow_conversation`` source over the desk's team
conversations. The agent's ``reply_mode`` says whether its words are sent while a person attends the ticket. Each one is the main
agent of a project of its own -- a project has one local deployment with one main agent, so a desk's two agents
could not both answer from one project.
"""

from __future__ import annotations

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.agent_spec import AgentReplyMode
from flow_sdk.schema.data_spec.helpdesk_agent_spec import HelpdeskAgent, HelpdeskAgentSide

PROVIDER = "helpdesk"
#: The channel each side's agent serves: the support agent the ticket (the customer's side), the internal agent the
#: desk's team conversations (``flow_conversation``) -- it never reads a ticket, and the support agent never reads there.
DRIVER_OF_SIDE = {HelpdeskAgentSide.CUSTOMER: PROVIDER, HelpdeskAgentSide.TEAM: "flow_conversation"}

#: What each side's agent does when the owner writes nothing of their own.
DEFAULT_INSTRUCTIONS = {
    HelpdeskAgentSide.CUSTOMER: (
        "You answer customers of this help desk, and only customers: you cannot read the team's conversation. When a "
        'ticket arrives, thank the customer at once ("Thank you, we are on it."), then send the team the request and its '
        'files with `flow conversation guest <ticket id> "<what the customer needs>"`, the only way you write to the team. '
        "The team's internal agent reaches you with steer messages: relay what it asks to the customer in your own words, "
        "and send the customer's answers back as guest messages. Write to the customer only to thank them, to ask what the "
        "team needs, to give the response the team hands you, and to close the ticket. Close it with `flow conversation close <ticket id>` when the customer has "
        "plainly confirmed it works. When it looks solved but they have not confirmed, say so with `flow conversation "
        "solved <ticket id>`: the desk closes it by itself after its number of days unless the customer writes again. "
        "Never promise a fix."
    ),
    HelpdeskAgentSide.TEAM: (
        "You are this help desk's internal agent, and you never write to the customer. Each screened request from the "
        "support agent, or a teammate tagging you, is yours to work: run /rca. When the RCA needs more from the customer, "
        'ask the support agent with `flow agent steer <support agent> <ticket id> "<what to ask>"` and run /rca again on '
        "the answer, until it is clear. Then report it to the team in this conversation: the likely cause, the evidence, "
        "the suggested fix. When a teammate asks for details, give them here. To send the customer the response, steer "
        "the support agent with it."
    ),
}

NAMES = {HelpdeskAgentSide.CUSTOMER: "customer agent", HelpdeskAgentSide.TEAM: "team agent"}

#: What each side's agent does with a turn's closing text: the customer's answers while it is alone with the ticket
#: and goes quiet once a person picks it up; the team's writes notes for the team, whoever attends.
REPLY_MODES = {HelpdeskAgentSide.CUSTOMER: AgentReplyMode.AUTO, HelpdeskAgentSide.TEAM: AgentReplyMode.ALWAYS}


async def _body() -> dict:
    request_info = get_current_request_info()
    return (await request_info.get_post_data() or {}) if request_info else {}


async def desk_agents(desk_project_id: str) -> list[HelpdeskAgent]:
    """The agents that own a source on this desk, one per side at most (the first found wins)."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

    found: dict[HelpdeskAgentSide, HelpdeskAgent] = {}
    sources = [
        (side, s) for side, provider in DRIVER_OF_SIDE.items() for s in await DataSource.get_all({"provider": provider})
    ]
    for side, source in sources:
        config = source.config or {}
        desk = config.get("desk_project_id")
        if (desk.get("id") if isinstance(desk, dict) else desk) != desk_project_id:
            continue
        owner = await owner_of(source)
        if owner is None or owner.type != "agent":
            continue
        agent = await Agent.get_by_id(owner.id)
        if agent is None or side in found:
            continue
        found[side] = HelpdeskAgent(
            desk_project_id=desk_project_id,
            side=side,
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

    driver = DataDriver.loaded(DRIVER_OF_SIDE[spec.side])
    if driver is None:
        raise LookupError(f"the {DRIVER_OF_SIDE[spec.side]} driver is not installed")
    name = f"{desk_name or 'Help desk'} {NAMES[spec.side]}"
    # Validated before anything is written: a refused config leaves no agent or project behind.
    config = driver.create_config(desk_project_id=spec.desk_project_id)
    project = await _project_for(name, someone)
    agent = await Agent(
        name=name,
        system_prompt=spec.instructions.strip() or DEFAULT_INSTRUCTIONS[spec.side],
        project_id=str(project.id),
        reply_mode=REPLY_MODES[spec.side],
    ).save()
    # The desk is answered from this deployment alone: named before the agent serves, so no second deployment of the
    # agent (another machine's copy of the project) answers it too.
    deployment = await agent.deploy("local")
    await driver.create_source(config, name=name, owner=agent, answer_place=str(deployment.id)).save()
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
