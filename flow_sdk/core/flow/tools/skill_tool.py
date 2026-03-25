"""Skill tool handler and tool creation function."""

from __future__ import annotations

import logging
from typing import Any

from pydantic_ai import RunContext, Tool
from pydantic_ai.messages import ToolReturnPart

from flow_sdk.core.flow.models.flow_data import ViewType
from flow_sdk.core.flow.streaming.response_handler import CallbackHandler

from .base import FlowToolHandler
from .models import ToolCallInvocationPart


class SkillToolHandler(FlowToolHandler):
    """Handler for Skill tool invocations - updates status and labels."""

    _callback_handler: CallbackHandler
    _compute_session: Any  # ComputeSession, imported lazily to avoid circular imports

    def __init__(
        self,
        callback_handler: CallbackHandler,
        compute_session: Any = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._callback_handler = callback_handler
        self._compute_session = compute_session

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        skill_name = ""
        if args := part.args_as_dict():
            skill_name = args.get("skill_name", "")

        # Update status
        await self._callback_handler.on_status(f"Loading skill: {skill_name}...")

        # Update chat_options labels with skill name
        if skill_name:
            await self._callback_handler.on_state(
                "chat_options",
                {"labels": {"model_choice": [skill_name]}},
            )

    async def on_tool_result(self, result: ToolReturnPart):
        await self._callback_handler.on_status("Thinking...")

        # Check stop_on_skill flag and request stop if set
        if self._compute_session and self._compute_session.completion_request.stop_on_skill:
            self._compute_session.request_stop("Skill completed", "Skill execution finished")


def create_skill_tool(skills_folder: str | None = None) -> Tool | None:
    """Create a Skill tool that loads and returns skill instructions.

    This provides a mock implementation of Claude Code's native Skill tool
    for PydanticAI workers to enable skill-based prompting. If the skill has
    target_resources, they are automatically deployed to the compute node.

    Args:
        skills_folder: Path to the .claude/skills folder

    Returns:
        Tool instance or None if no skills folder provided
    """
    if not skills_folder:
        return None

    from pathlib import Path

    skills_path = Path(skills_folder)
    if not skills_path.exists():
        logging.info(f"Skills folder does not exist: {skills_path}")
        return None

    # Import here to avoid circular dependency
    from flow_sdk.core.flow.instructions.skill_manager import SkillDeployer, SkillManager

    try:
        skill_manager = SkillManager.from_folder(skills_path)
        if len(skill_manager) == 0:
            return None
    except Exception as e:
        logging.warning(f"Failed to load skills from {skills_path}: {e}")
        return None

    # Get list of available skill names for the description
    skill_names = skill_manager.names

    async def invoke_skill(ctx: RunContext[Any], skill_name: str) -> str:
        """Load and return a skill's instructions.

        If the skill has deployable resources, they are automatically deployed.

        Args:
            ctx: Runtime context with ComputeSession
            skill_name: Name of the skill to invoke

        Returns:
            The skill's instructions and content
        """
        skill = skill_manager.get(skill_name)
        if not skill:
            available = ", ".join(skill_names)
            return f"Error: Skill '{skill_name}' not found. Available skills: {available}"
        deps = ctx.deps
        callback = deps.callback_handler
        # Deploy resources if skill has target_resources
        deployment_info = ""
        if skill.has_target_resources:
            await callback.on_status(f"Deploying resources for skill: {skill_name}...")

            # Focus on shell view for deployment output
            await callback.on_focus(ViewType.SHELL)

            # Create deployer with callback for status and output streaming
            deployer = SkillDeployer(deps.mcp_connector, callback=callback)
            result = await deployer.deploy(skill)

            if result.deployed:
                deployment_info = "\n\n## Deployment Status\n✓ Resources deployed successfully."
                if result.post_deploy_output:
                    deployment_info += f"\n\n### Post-deployment output:\n```\n{result.post_deploy_output}\n```"
            elif result.skipped:
                deployment_info = "\n\n## Deployment Status\n✓ Resources already deployed (skipped)."
            else:
                deployment_info = f"\n\n## Deployment Status\n✗ Deployment failed: {result.error}"

        # Build response with metadata, instructions, and resources
        response_parts = []

        # Add metadata
        response_parts.append(f"# Skill: {skill.metadata.name}")
        response_parts.append(f"**Description:** {skill.metadata.description}")

        if skill.metadata.tags:
            response_parts.append(f"**Tags:** {', '.join(skill.metadata.tags)}")

        if skill.metadata.allowed_tools:
            response_parts.append(f"**Allowed Tools:** {', '.join(skill.metadata.allowed_tools)}")

        response_parts.append("")

        # Add main instructions
        response_parts.append("## Instructions")
        response_parts.append(skill.content)

        # Add resources if any (but not from target_resources as they're deployed)
        if len(skill.resources) > 0:
            response_parts.append("")
            response_parts.append("## Resources")
            for resource in skill.resources:
                # Skip files in target_resources as they're deployed, not instructions
                if "target_resources" in resource.relative_path:
                    continue
                response_parts.append(f"### {resource.relative_path}")
                response_parts.append("```")
                response_parts.append(resource.content)
                response_parts.append("```")
                response_parts.append("")

        # Add deployment info at the end
        if deployment_info:
            response_parts.append(deployment_info)

        return "\n".join(response_parts)

    return Tool(
        function=invoke_skill,
        name="get_skill",
        description=(
            "Get detailed instructions for a specific skill and deploy its resources. "
            "Use when you need step-by-step guidance for a task type. "
            "If the skill has deployable resources (like project templates), "
            "they will be automatically deployed to the working directory. "
            f"Available skills: {', '.join(skill_names)}."
        ),
    )
