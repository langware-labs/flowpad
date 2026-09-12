"""Filesystem contracts independent of application entities."""
from typing import Optional

from flow_sdk.schema.data_spec import Body, FrontMatter, SpecType


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
    input: Optional[SpecType] = None
    output: Optional[SpecType] = None
    system_prompt: Body = ""
