"""A help desk's optional agents, set up from the desk's own page.

POST /api/v1/graph/helpdesk-agents  {desk_project_id}           — the desk's agents on this machine, by side
POST /api/v1/graph/helpdesk-agent   {HelpdeskAgent fields}       — make one: its project, the agent, its source on the
                                                                   desk, where it runs (the support agent on a cloud
                                                                   machine, the internal agent here), and the hub told
                                                                   which agent it is

A desk agent is an ordinary agent that owns a source on the desk: the support agent (customer side) a source of the
driver that serves tickets, the internal agent (team side) one of the driver that serves the desk's team
conversations. Each driver declares its side (``MessageSource.desk_agent_side``); nothing here names one. The agent's
``reply_mode`` says whether its words are sent while a person attends the ticket. Each one is the main agent of a
project of its own -- a project has one local deployment with one main agent, so a desk's two agents could not both
answer from one project. The support agent runs only in the cloud, under its own hub Identity; the internal agent on
the owner's computer. Once one is made, the hub learns the desk's support and internal agent
(``project/<desk>/helpdesk_agents``): it makes the support agent the desk's staff and gives the internal agent
``admin`` on it, the standing a steer needs.
"""

from __future__ import annotations

from flow_sdk.actions.action_registry import action
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.agent_spec import AgentReplyMode
from flow_sdk.schema.data_spec.helpdesk_agent_spec import HelpdeskAgent, HelpdeskAgentSide

#: The hub's names for the desk's two agents in ``project/<desk>/helpdesk_agents``.
HUB_FIELD_OF_SIDE = {HelpdeskAgentSide.CUSTOMER: "support_agent", HelpdeskAgentSide.TEAM: "internal_agent"}


def driver_of(side: HelpdeskAgentSide):
    """The loaded driver whose channel a desk agent of *side* serves (it declares ``desk_agent_side``), or ``None``."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    return next((d for _key, d in DRIVERS.items() if getattr(d.cls, "desk_agent_side", None) == side), None)


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
    drivers = [(side, driver_of(side)) for side in HelpdeskAgentSide]
    sources = [
        (side, s)
        for side, driver in drivers
        if driver is not None
        for s in await DataSource.get_all({"provider": driver.name})
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
    """Its project, the agent and its source on the desk (saying the side and when it replies), then where it runs.

    The support agent talks to strangers, so it never runs on this computer under its owner's login: it is deployed to
    a cloud machine of its own, which signs in as the agent's own hub Identity (``Project.deploy``, the path of
    ``flow agent deploy``). The internal agent runs here."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    driver = driver_of(spec.side)
    if driver is None:
        raise LookupError(f"no installed driver serves a desk's {spec.side.value} side")
    if spec.side is HelpdeskAgentSide.CUSTOMER and someone is None:
        raise ValueError("the support agent is deployed to the cloud: sign in first")
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
    if spec.side is HelpdeskAgentSide.CUSTOMER:
        from flow_sdk.builtin.cloud_deploy import DEFAULT_CLOUD_PROVIDER  # noqa: PLC0415

        # Saved before the deploy: the source is a file of the agent's project, which the deploy publishes and the
        # machine clones, and the plan names its desk (``Agent.hub_desks``) so the hub makes the agent's Identity the
        # desk's staff. No ``answer_place``: the machine is the one place answering (the driver's ``single_place``).
        await driver.create_source(config, name=name, owner=agent).save()
        await project.deploy(someone, provider=DEFAULT_CLOUD_PROVIDER, main_agent=agent)
    else:
        # The desk is answered from this deployment alone: named before the agent serves, so no second deployment of
        # the agent (another machine's copy of the project) answers it too.
        deployment = await agent.deploy("local")
        await driver.create_source(config, name=name, owner=agent, answer_place=str(deployment.id)).save()
        await agent.run_locally()
    return spec.model_copy(update={"agent_id": str(agent.id), "agent_name": agent.name})


async def wire_desk_agent(made: HelpdeskAgent, someone) -> dict:
    """Tell the hub *made* is the desk's support or internal agent (the field of the other side is left out, which
    keeps its agent). The hub grants roles on its own copy of the agent: the internal agent is published first; the
    support agent's deploy already published it. Answers the desk's helpdesk config as the hub holds it; raises
    ``HubError``."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    if made.side is HelpdeskAgentSide.TEAM:
        agent = await Agent.get_by_id(str(made.agent_id))
        if agent is None:
            raise LookupError(f"no agent {made.agent_id}")
        await agent.ensure_on_hub(someone)
    return await HubProxy.call(
        "POST",
        BuiltinEntityType.PROJECT,
        made.desk_project_id,
        "helpdesk_agents",
        payload={HUB_FIELD_OF_SIDE[made.side]: str(made.agent_id)},
        strict=True,
    )


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
    request_info = get_current_request_info()
    someone = request_info.someone_typeid if request_info else None
    try:
        made = await create_desk_agent(spec, str(body.get("desk_name") or ""), someone)
    except (LookupError, ValueError) as e:
        return ApiFailResponse(message=str(e), status_code=400)
    except HubError as e:
        return e.fail_response(f"The {NAMES[spec.side]} was made, but its deploy failed")
    except Exception as e:  # noqa: BLE001 — a refused deploy (not ready, already running, unpublishable)
        return ApiFailResponse(message=f"The {NAMES[spec.side]} was made, but its deploy failed: {e}", status_code=409)
    refused = f"The {NAMES[spec.side]} was made, but the hub did not take it as the desk's agent"
    try:
        await wire_desk_agent(made, someone)
    except HubError as e:
        return e.fail_response(refused)
    except Exception as e:  # noqa: BLE001 — publishing the agent to the hub failed; the agent itself stands
        return ApiFailResponse(message=f"{refused}: {e}", status_code=502)
    return ApiSuccessResponse(data=made.model_dump(mode="json"))
