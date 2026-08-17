"""The resolution seam — how every caller gets from a name to a launch.

One pair of helpers — the single way anything gets from a name to a launch::

    dep = await get_agent_local_deployment("asset-cleanup")
    proc = await dep.launch("clean up this project")

Accepts a bare name (``"asset-cleanup"``), a ``TypeId`` or its string form
(``"agent-<uuid>"``), so call sites don't have to know which they hold.
"""
from typing import TYPE_CHECKING, Optional, Union

from flow_sdk.api.type_id import TypeId

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment

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
    them, and two callers never touch the server at all (``flow diagnose`` and
    the migration runner both run standalone). So resolving one must not depend
    on the indexer having walked the assistant project yet. The DB row still
    wins whenever it exists: that is the copy a user can edit.

    This goes through ``Entity.from_fs_ref`` — the DB-free loader that runs the
    SAME ``from_disk_fn`` the indexer runs and resolves the id through
    ``TypeInfo.extract_id``. Parsing the markdown here instead would fork the
    two paths: ``extract_id`` is the mandated v4/v5 adoption gate, and it also
    consults the registered ``frontmatter_id`` legacy reader, so a hand-read
    capsule would hand back a DIFFERENT id for any agent.md carrying its id in
    frontmatter — splitting the deployment id, which is the exact failure this
    function exists to avoid.

    Returned UNSAVED and deliberately so — persisting here would run the
    ``owns_main_ref`` render and rewrite the shipped file.
    """
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    info = SchemaRegistry.get(EntityType.AGENT.value)
    if info is None or not info.main_subdir or not info.main_file:
        return None
    # Placement comes off the type, not a literal: family_subdir is the single
    # seam for the mount rule, so the fallback can't drift from the walk.
    path = flowpad_assistant_project_root() / info.main_subdir / name / info.main_file
    if not path.is_file():
        return None
    # read_only: the shipped file is package data — minting must never write to it.
    ref = FSRef(path, record_type=EntityType.AGENT, read_only=True)
    found = Agent.from_fs_ref(ref, record_type=EntityType.AGENT.value)
    return found if isinstance(found, Agent) else None


async def get_agent_local_deployment(ref: AgentRef) -> "Deployment":
    """The agent's ``local`` deployment — created on first use.

    Raises when the agent doesn't resolve: a launch site naming an agent that
    doesn't exist is a bug we want loud, not a silent no-op.
    """
    agent = await get_agent(ref)
    if agent is None:
        raise LookupError(f"no Agent named {ref!r}")
    return await agent.local_deployment()
