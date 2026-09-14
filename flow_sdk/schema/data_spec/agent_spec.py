"""Filesystem contracts independent of application entities."""
from typing import ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec import Body, FrontMatter, SpecType
from flow_sdk.schema.data_spec.spec import DataSpec

#: The launch settings a place may override. Anything else is the definition's.
PLACE_OVERRIDABLE_FIELDS: tuple[str, ...] = ("worker_type", "model", "permission_mode", "effort", "mcp_servers")


class AgentPlaceSpec(DataSpec):
    """How this agent runs on ONE place — a Deployment it is placed on.

    Keyed by the Deployment id and carried in agent.md, so a place's overrides
    travel with the definition like its schedules do; each machine applies only
    the entry naming a placement that runs there. ``None`` = inherit the
    definition. ``mcp_servers`` names servers (names travel; ids do not).
    """

    spec_kind: ClassVar[str] = "agent.place"
    model_config = ConfigDict(extra="forbid", frozen=True)

    deployment_id: str
    #: Whether the agent runs on this place at all. ``None`` = the definition's ``enabled``.
    #: A gate, not a launch setting — so it is not in ``overrides()``.
    enabled: Optional[bool] = None
    worker_type: Optional[str] = None
    model: Optional[str] = None
    permission_mode: Optional[str] = None
    effort: Optional[str] = None
    mcp_servers: Optional[list[str]] = None

    def overrides(self) -> dict:
        """The fields this place actually overrides."""
        return {name: getattr(self, name) for name in PLACE_OVERRIDABLE_FIELDS if getattr(self, name) is not None}


class AgentSpec(FrontMatter):
    """``agent.md`` — the shape of the document. ``name`` is deliberately NOT
    here: it comes from the folder (``TypeInfo.name_from_path``), so a rename
    can never desync the two. ``system_prompt`` is the markdown ``Body``.

    ``input`` / ``output`` are the agent's I/O contract — shapes authored
    in YAML. They are declaration only and never enter ``to_agent_options``:
    that bundle is md5'd into ``last_started_hash``, and a new key there would
    flip ``restart_required`` on every running process.
    """

    title: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    worker_type: Optional[str] = None
    model: Optional[str] = None
    permission_mode: Optional[str] = None
    effort: Optional[str] = None
    max_turns: Optional[int] = None
    tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    skills: Optional[list[str]] = None
    mcp_servers: Optional[list[str]] = None
    subagents: Optional[list[str]] = None
    additional_dirs: Optional[list[str]] = None
    load_flowpad_assistant: Optional[bool] = None
    cli_options: Optional[dict] = None
    enabled: Optional[bool] = None
    intro: Optional[str] = None
    auto_launch: Optional[bool] = None
    auto_launch_prompt: Optional[str] = None
    #: Per-place launch overrides, keyed by Deployment id.
    places: Optional[list[AgentPlaceSpec]] = None
    #: The ONE place (Deployment id) that answers this agent's email. Unset = legacy:
    #: every machine that polls the mailbox answers.
    email_place: Optional[str] = None
    input: Optional[SpecType] = None
    output: Optional[SpecType] = None
    system_prompt: Body = ""
