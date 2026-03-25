"""
Skill catalog instructions for FlowPad AI agents.

Generates a system prompt section listing available skills
with names and descriptions. Agent calls get_skill() for full details.
"""

from pathlib import Path

from flow_sdk.builtin.knowledge_base.knowledge_data import KnowledgeData
from flow_sdk.core.flow.instructions.skill_manager import SkillManager


def create_skill_catalog_instructions(skills_folder: str | Path) -> KnowledgeData:
    """
    Create system prompt section listing available skills.

    Only includes skill names and descriptions - agent calls
    get_skill(skill_name) tool to get full instructions.

    Args:
        skills_folder: Path to folder containing skill definitions

    Returns:
        KnowledgeData with skill catalog prompt
    """
    knowledge = KnowledgeData()

    try:
        skills_path = Path(skills_folder).expanduser().resolve()

        if not skills_path.exists():
            return knowledge

        manager = SkillManager.from_folder(skills_path)

        if len(manager) == 0:
            return knowledge

        prompt = "## Available Skills\n\n"
        prompt += "Call `get_skill(skill_name)` to get detailed instructions for a skill.\n\n"

        for skill in manager:
            prompt += f"- **{skill.metadata.name}**: {skill.metadata.description}\n"

        prompt += "\n"

        knowledge.add_instruction(content=prompt, name="skill_catalog")

    except Exception:
        pass  # No skills available or error loading

    return knowledge
