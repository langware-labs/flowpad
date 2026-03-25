"""Flow tools package - handlers and tool creation functions."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable

from pydantic_ai import Tool

from flow_sdk.core.flow.streaming.response_handler import CallbackHandler

from .base import FlowTextHandler, FlowToolBox, FlowToolHandler, GenericToolHandler, no_op_on_write
from .models import (
    FlowStreamEvent,
    FlowToolDescription,
    SearchConfig,
    SearchMode,
    ToolCallInvocationPart,
)
from .search_tool import SearchToolHandler, create_search_tool, create_web_fetch_tool
from .shell_tool import ShellToolHandler
from .skill_tool import SkillToolHandler, create_skill_tool

if TYPE_CHECKING:
    from flow_sdk.core.flow.models.process_deps import ComputeSession


def get_tool_box(
    callback_handler: CallbackHandler,
    on_write: Callable[[str, str], Awaitable[None]] | None = None,
    on_env_var: Callable[[str, str, str], Awaitable[None]] | None = None,
    compute_session: Any = None,
):
    """Utility function to get a tool box with the default handlers.

    Args:
        callback_handler: Handler for streaming callbacks
        on_write: Callback when a file is written
        on_env_var: Callback when an environment variable is set
        compute_session: ComputeSession for stop_on_skill flag support
    """
    return FlowToolBox(
        text_handler=FlowTextHandler(
            callback_handler=callback_handler,
            on_write=on_write or no_op_on_write,
            on_env_var=on_env_var,
        ),
        tool_handlers={
            "shell": ShellToolHandler(callback_handler),
            "web_search": SearchToolHandler(callback_handler),
            "fetch_web_content": SearchToolHandler(callback_handler),
            "get_skill": SkillToolHandler(callback_handler, compute_session=compute_session),
        },
        default_handler=GenericToolHandler(callback_handler),
    )


def get_tools(
    search_config: SearchConfig | None = None,
    enable_search: bool = False,
    tool_types: list[str] | None = None,
    skills_folder: str | None = None,
    enable_skills: bool = False,
) -> list[Tool["ComputeSession"]]:
    """
    Get a list of tools based on the specified parameters.

    Args:
        search_config: Configuration for search-related tools
        enable_search: Whether to include search-related tools
        tool_types: Specific tool types to include (e.g., ['search', 'fetch'])
        skills_folder: Path to the .claude/skills folder for skill tool
        enable_skills: Whether to include the Skill tool

    Returns:
        List of configured tools
    """
    tools = []

    if enable_search:
        # Default to both tools if no specific types requested
        if tool_types is None:
            tool_types = ["search", "fetch"]

        if "search" in tool_types:
            search_tool = create_search_tool(search_config)
            if search_tool is not None:
                tools.append(search_tool)

        if "fetch" in tool_types:
            web_fetch_tool = create_web_fetch_tool(search_config)
            if web_fetch_tool is not None:
                tools.append(web_fetch_tool)

    # Add Skill tool if enabled
    if enable_skills and skills_folder:
        skill_tool = create_skill_tool(skills_folder)
        if skill_tool is not None:
            tools.append(skill_tool)

    return tools


__all__ = [
    # Models
    "FlowStreamEvent",
    "FlowToolDescription",
    "SearchConfig",
    "SearchMode",
    "ToolCallInvocationPart",
    # Base classes
    "FlowTextHandler",
    "FlowToolBox",
    "FlowToolHandler",
    "no_op_on_write",
    # Tool handlers
    "GenericToolHandler",
    "SearchToolHandler",
    "ShellToolHandler",
    "SkillToolHandler",
    # Tool creation functions
    "create_search_tool",
    "create_skill_tool",
    "create_web_fetch_tool",
    # Utility functions
    "get_tool_box",
    "get_tools",
]
