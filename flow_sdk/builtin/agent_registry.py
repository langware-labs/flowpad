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
    found = await Agent.get_one({"name": text})
    return found if found is not None else _shipped_agent(text)


def _shipped_agent(name: str) -> Optional["Agent"]:
    """Read a shipped agent straight off disk when the DB has no row for it.

    The internal agents ship inside the package, next to the code that launches
    them — so resolving one must not depend on the indexer having walked the
    assistant project yet. Without this, every converted launch site breaks on a
    cold instance (and in any test with an empty DB) even though the agent.md is
    right there. The DB row still wins whenever it exists: that is the copy a
    user can edit.

    Returned UNSAVED and deliberately so — persisting here would run the
    ``owns_main_ref`` render and rewrite the shipped file from a partial row.
    """
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions.agent import parse_agent_markdown  # noqa: PLC0415

    path = flowpad_assistant_project_root() / "agentic-assets" / "agent" / name / "agent.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    parsed = parse_agent_markdown(text, name)
    # A shipped agent.md carries an identity capsule, so read the id from there
    # rather than minting one: the fallback Agent must be the SAME entity the
    # indexer will produce, or its deployment id would change the moment the
    # walk lands and `runs()` would split across two deployments.
    from flow_sdk.capsules import CodeCommentCapsule  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE  # noqa: PLC0415

    agent_id = None
    try:
        capsule = CodeCommentCapsule(path).read(IDENTITY_CAPSULE.name)
        if capsule is not None:
            agent_id = (capsule.data or {}).get("id")
    except Exception:
        agent_id = None
    return Agent(**({"id": str(agent_id)} if agent_id else {}), **parsed)


async def get_agent_local_deployment(ref: AgentRef) -> "AgentDeployment":
    """The agent's ``local`` deployment — created on first use.

    Raises when the agent doesn't resolve: a launch site naming an agent that
    doesn't exist is a bug we want loud, not a silent no-op.
    """
    agent = await get_agent(ref)
    if agent is None:
        raise LookupError(f"no Agent named {ref!r}")
    return await agent.local_deployment()
