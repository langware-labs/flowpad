"""
Claude Code Skill Manager

A Pythonic interface for parsing and working with Claude Code skill folders.

Usage:
    from flow_sdk.core.flow.instructions.skill_manager import SkillManager

    # Load skills from directory
    skills = SkillManager.from_folder("~/.claude/skills")

    # Access skill
    skill = skills["pdf-processing"]
    print(skill.metadata.name)
    print(skill.content)

    # Access resources
    doc = skill.resources["scripts/helper.py"]
    print(doc.content)
"""

from .deployer import DeploymentResult, SkillDeployer
from .manager import SkillManager
from .models import SKILL_REFERENCES_FOLDER, Skill, SkillMetadata, SkillParseError, SkillResource, SkillResources
from .skill_catalog import generate_skill_catalog, get_available_skills_xml

__all__ = [
    "SKILL_REFERENCES_FOLDER",
    "SkillManager",
    "Skill",
    "SkillMetadata",
    "SkillResource",
    "SkillResources",
    "SkillParseError",
    "SkillDeployer",
    "DeploymentResult",
    "generate_skill_catalog",
    "get_available_skills_xml",
]
