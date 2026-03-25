"""
SkillManager - Entry point for loading and managing Claude Code skills.

Usage:
    from flow_sdk.core.flow.instructions.skill_manager import SkillManager

    # Load all skills from a directory
    skills = SkillManager.from_folder("~/.claude/skills")

    # Load a single skill
    skill = SkillManager.from_folder("path/to/my-skill")

    # Access skills
    for skill in skills:
        print(skill.metadata.name)
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .models import Skill, SkillParseError

if TYPE_CHECKING:
    from flow_sdk.core.flow.mcp_server import MCPConnector

    from .deployer import DeploymentResult


class SkillManager:
    """
    Manager for loading and accessing Claude Code skills.

    Can load from:
    - A directory containing multiple skill folders
    - A single skill folder (containing SKILL.md)
    """

    def __init__(self, skills: list[Skill] | None = None):
        self._skills: list[Skill] = skills or []
        self._by_name: dict[str, Skill] = {s.metadata.name: s for s in self._skills}

    @classmethod
    def from_folder(cls, folder_path: str | Path) -> SkillManager:
        """
        Load skills from a folder.

        If folder contains SKILL.md, loads as single skill.
        Otherwise, scans subdirectories for skill folders.

        Args:
            folder_path: Path to skills directory or single skill folder

        Returns:
            SkillManager with loaded skills
        """
        path = Path(folder_path).expanduser().resolve()

        if not path.exists():
            raise SkillParseError(f"Folder does not exist: {path}")

        if not path.is_dir():
            raise SkillParseError(f"Path is not a directory: {path}")

        # Check if this is a single skill folder
        if (path / "SKILL.md").exists():
            skill = Skill.from_folder(path)
            return cls([skill])

        # Scan for skill subdirectories
        skills = []
        for item in path.iterdir():
            if item.is_dir() and (item / "SKILL.md").exists():
                try:
                    skill = Skill.from_folder(item)
                    skills.append(skill)
                except SkillParseError:
                    # Skip invalid skills
                    pass

        return cls(skills)

    def __getitem__(self, key: int | str) -> Skill:
        """Get skill by index or name."""
        if isinstance(key, int):
            return self._skills[key]
        return self._by_name[key]

    def __contains__(self, name: str) -> bool:
        """Check if skill exists by name."""
        return name in self._by_name

    def __iter__(self) -> Iterator[Skill]:
        """Iterate over all skills."""
        return iter(self._skills)

    def __len__(self) -> int:
        """Number of loaded skills."""
        return len(self._skills)

    def get(self, name: str) -> Skill | None:
        """Get skill by name, returns None if not found."""
        return self._by_name.get(name)

    def find(self, query: str) -> list[Skill]:
        """Find skills with query in name or description (case-insensitive)."""
        query_lower = query.lower()
        return [
            s
            for s in self._skills
            if query_lower in s.metadata.name.lower() or query_lower in s.metadata.description.lower()
        ]

    def add(self, skill: Skill) -> None:
        """Add a skill to the manager."""
        self._skills.append(skill)
        self._by_name[skill.metadata.name] = skill

    def remove(self, name: str) -> bool:
        """Remove skill by name. Returns True if removed."""
        if name not in self._by_name:
            return False
        skill = self._by_name.pop(name)
        self._skills.remove(skill)
        return True

    def add_folder(self, folder_path: str | Path) -> "SkillManager":
        """
        Add skills from another folder to this manager.

        Loads skills from the specified folder and adds them to this manager.
        Skills with names that already exist are skipped (first added wins).

        Args:
            folder_path: Path to skills directory or single skill folder

        Returns:
            Self for method chaining

        Example:
            manager = SkillManager.from_folder("production_skills")
            manager.add_folder("test_skills")  # test skills added, conflicts skipped
        """
        path = Path(folder_path).expanduser().resolve()

        if not path.exists():
            # Silently skip non-existent folders
            return self

        if not path.is_dir():
            return self

        # Check if this is a single skill folder
        if (path / "SKILL.md").exists():
            try:
                skill = Skill.from_folder(path)
                if skill.metadata.name not in self._by_name:
                    self.add(skill)
            except SkillParseError:
                pass
            return self

        # Scan for skill subdirectories
        for item in path.iterdir():
            if item.is_dir() and (item / "SKILL.md").exists():
                try:
                    skill = Skill.from_folder(item)
                    # Only add if not already present (first added wins)
                    if skill.metadata.name not in self._by_name:
                        self.add(skill)
                except SkillParseError:
                    # Skip invalid skills
                    pass

        return self

    @property
    def names(self) -> list[str]:
        """List all skill names."""
        return list(self._by_name.keys())

    def to_list(self) -> list[dict]:
        """Export all skills as list of dicts."""
        return [s.to_dict() for s in self._skills]

    def copy_to(self, destination: str | Path, clear_existing: bool = True) -> Path:
        """
        Copy all skills to a destination directory.

        Creates .claude/skills/ structure at destination and copies
        each skill folder there. Claude Code will auto-discover skills
        from this location when cwd is set to destination.

        Args:
            destination: Target directory (will contain .claude/skills/)
            clear_existing: If True, removes existing skills dir before copying

        Returns:
            Path to the created skills directory
        """
        dest_path = Path(destination).expanduser().resolve()
        skills_dir = dest_path / ".claude" / "skills"

        # Clear existing skills if requested
        if clear_existing and skills_dir.exists():
            shutil.rmtree(skills_dir)

        # Create skills directory
        skills_dir.mkdir(parents=True, exist_ok=True)

        # Copy each skill
        for skill in self._skills:
            skill_dest = skills_dir / skill.metadata.name
            shutil.copytree(skill.path, skill_dest)

        return skills_dir

    def to_available_skills_list(self) -> str:
        """
        Generate the <available_skills> XML format used by Claude Code.

        Returns:
            XML-style list of skills with names and descriptions.
        """
        if not self._skills:
            return "<available_skills>\n</available_skills>"

        lines = ["<available_skills>"]
        for skill in self._skills:
            lines.append(f'  <skill name="{skill.metadata.name}">')
            lines.append(f"    {skill.metadata.description}")
            lines.append("  </skill>")
        lines.append("</available_skills>")

        return "\n".join(lines)

    async def deploy_resources(self, mcp_connector: "MCPConnector") -> list["DeploymentResult"]:
        """
        Deploy target_resources for all skills that have them.

        Args:
            mcp_connector: MCPConnector with shell and fs MCP servers

        Returns:
            List of deployment results for skills with target_resources
        """
        from .deployer import SkillDeployer

        deployer = SkillDeployer(mcp_connector)
        results = []

        for skill in self._skills:
            if skill.has_target_resources:
                result = await deployer.deploy(skill)
                results.append(result)

        return results

    def __repr__(self) -> str:
        return f"SkillManager(skills={len(self._skills)})"
