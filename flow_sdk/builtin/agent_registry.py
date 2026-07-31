"""The resolution seam — how every caller gets from a name to a launch.

One pair of helpers, mirrored in ``ts_sdk``, so UI and backend resolve agents
identically::

    dep = await get_agent_local_deployment("asset-cleanup")
    proc = await dep.launch("clean up this project")

Accepts a bare name (``"asset-cleanup"``), a ``TypeId`` or its string form
(``"agent-<uuid>"``), so call sites don't have to know which they hold.
"""
from typing import TYPE_CHECKING, Optional, Union

from flow_sdk.api.type_id import TypeId

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agent_deployment import AgentDeployment

AgentRef = Union[str, TypeId, "Agent"]


async def get_agent(ref: AgentRef) -> Optional["Agent"]:
    """Resolve *ref* to an Agent: by id when it looks like one, else by name."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    if isinstance(ref, Agent):
        return ref
    if isinstance(ref, TypeId):
        return await Agent.get_by_id(ref.id)

    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

    text = str(ref).strip()
    if not text:
        return None
    # "agent-<uuid>" — the wire form used by graph nodes and the UI. Names
    # contain hyphens too ("asset-cleanup"), so parse defensively.
    if text.startswith(f"{Agent.get_type()}-") and TypeId.is_typeid(text):
        found = await Agent.get_by_id(TypeId(text).id)
        if found is not None:
            return found
    # get_by_id validates and RAISES on a non-uuid, so only ask when it is one.
    if is_valid_entity_id(text):
        found = await Agent.get_by_id(text)
        if found is not None:
            return found
    return await Agent.get_one({"name": text})


async def get_agent_local_deployment(ref: AgentRef) -> "AgentDeployment":
    """The agent's ``local`` deployment — created on first use.

    Raises when the agent doesn't resolve: a launch site naming an agent that
    doesn't exist is a bug we want loud, not a silent no-op.
    """
    agent = await get_agent(ref)
    if agent is None:
        raise LookupError(f"no Agent named {ref!r}")
    return await agent.local_deployment()
