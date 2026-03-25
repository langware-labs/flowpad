"""
Skill data models for Claude Code skill parsing.

Classes:
    SkillMetadata - YAML frontmatter (name, description, allowed_tools)
    SkillResource - File within a skill folder
    Skill - Complete skill with metadata, content, and resources
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# Subfolder within a skill folder for reference files (analysis.md, analysis.json, etc.)
SKILL_REFERENCES_FOLDER = "references"


@dataclass
class SkillMetadata:
    """
    YAML frontmatter from SKILL.md.

    Attributes:
        name: Skill identifier (lowercase, hyphens)
        description: What the skill does and when to use it
        allowed_tools: Optional list of permitted tools
        tags: Optional list of tags for categorization
        extra: Additional frontmatter fields
    """

    name: str
    description: str
    allowed_tools: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "allowed_tools": self.allowed_tools,
            "tags": self.tags,
            **self.extra,
        }


@dataclass
class SkillResource:
    """
    A file within a skill folder.

    Attributes:
        path: Absolute path to the file
        relative_path: Path relative to skill folder (e.g., "scripts/helper.py")
    """

    path: Path
    relative_path: str
    _content: str | None = field(default=None, repr=False)

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def absolute_path(self) -> str:
        return str(self.path.resolve())

    @property
    def extension(self) -> str:
        return self.path.suffix

    @property
    def content(self) -> str:
        if self._content is None:
            self._content = self.path.read_text(encoding="utf-8")
        return self._content

    @property
    def is_script(self) -> bool:
        return self.extension in {".py", ".js", ".ts", ".sh", ".bash"}

    @property
    def is_markdown(self) -> bool:
        return self.extension in {".md", ".markdown"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "relative_path": self.relative_path,
            "extension": self.extension,
        }


class SkillResources:
    """
    Dict-like container for skill resources.

    Access by relative path: resources["scripts/helper.py"]
    """

    def __init__(self, resources: list[SkillResource]):
        self._resources = {r.relative_path: r for r in resources}

    def __getitem__(self, key: str) -> SkillResource:
        return self._resources[key]

    def __contains__(self, key: str) -> bool:
        return key in self._resources

    def __iter__(self):
        return iter(self._resources.values())

    def __len__(self) -> int:
        return len(self._resources)

    def keys(self) -> list[str]:
        return list(self._resources.keys())

    def get(self, key: str) -> SkillResource | None:
        return self._resources.get(key)


@dataclass
class Skill:
    """
    A complete Claude Code skill.

    Attributes:
        path: Path to skill folder
        metadata: Parsed YAML frontmatter
        content: SKILL.md body (instructions)
        resources: Files in the skill folder
    """

    path: Path
    metadata: SkillMetadata
    content: str
    resources: SkillResources

    @property
    def absolute_path(self) -> str:
        return str(self.path.resolve())

    @property
    def target_resources_path(self) -> Path | None:
        """Path to target_resources folder if it exists."""
        target = self.path / "target_resources"
        return target if target.exists() and target.is_dir() else None

    @property
    def has_target_resources(self) -> bool:
        """Check if skill has deployable resources."""
        return self.target_resources_path is not None

    @property
    def marker_filename(self) -> str:
        """Marker file name for this skill deployment."""
        return f"skill.{self.metadata.name}.json"

    @classmethod
    def from_folder(cls, folder_path: str | Path) -> Skill:
        """
        Parse a skill from a folder containing SKILL.md.

        Args:
            folder_path: Path to skill folder

        Returns:
            Parsed Skill instance

        Raises:
            SkillParseError: If folder or SKILL.md is invalid
        """
        path = Path(folder_path).expanduser().resolve()

        if not path.exists():
            raise SkillParseError(f"Skill folder does not exist: {path}")

        if not path.is_dir():
            raise SkillParseError(f"Path is not a directory: {path}")

        skill_md = path / "SKILL.md"
        if not skill_md.exists():
            raise SkillParseError(f"SKILL.md not found in: {path}")

        # Parse SKILL.md
        raw_content = skill_md.read_text(encoding="utf-8")
        metadata, content = cls._parse_skill_md(raw_content, skill_md)

        # Collect resources
        resources = cls._collect_resources(path)

        return cls(
            path=path,
            metadata=metadata,
            content=content,
            resources=resources,
        )

    @staticmethod
    def _parse_skill_md(raw_content: str, file_path: Path) -> tuple[SkillMetadata, str]:
        """Parse YAML frontmatter and content from SKILL.md."""
        pattern = r"^---\s*\n(.*?)\n---\s*\n(.*)$"
        match = re.match(pattern, raw_content, re.DOTALL)

        if not match:
            raise SkillParseError(f"Invalid SKILL.md format (missing frontmatter): {file_path}")

        frontmatter_yaml = match.group(1)
        content = match.group(2).strip()

        try:
            frontmatter = yaml.safe_load(frontmatter_yaml) or {}
        except yaml.YAMLError as e:
            raise SkillParseError(f"Invalid YAML frontmatter in {file_path}: {e}") from e

        # Extract required fields
        name = frontmatter.pop("name", None)
        if not name:
            raise SkillParseError(f"Missing 'name' in frontmatter: {file_path}")

        description = frontmatter.pop("description", "")

        # Extract allowed-tools
        allowed_tools_raw = frontmatter.pop("allowed-tools", "")
        if isinstance(allowed_tools_raw, str):
            allowed_tools = [t.strip() for t in allowed_tools_raw.split(",") if t.strip()]
        elif isinstance(allowed_tools_raw, list):
            allowed_tools = allowed_tools_raw
        else:
            allowed_tools = []

        # Extract tags
        tags_raw = frontmatter.pop("tags", [])
        if isinstance(tags_raw, list):
            tags = tags_raw
        elif isinstance(tags_raw, str):
            tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
        else:
            tags = []

        metadata = SkillMetadata(
            name=name,
            description=description,
            allowed_tools=allowed_tools,
            tags=tags,
            extra=frontmatter,
        )

        return metadata, content

    @classmethod
    def _collect_resources(cls, skill_path: Path) -> SkillResources:
        """Collect all files in skill folder (excluding SKILL.md)."""
        resources = []
        for file_path in skill_path.rglob("*"):
            if file_path.is_file() and file_path.name != "SKILL.md":
                relative = file_path.relative_to(skill_path).as_posix()
                resources.append(SkillResource(path=file_path, relative_path=relative))
        return SkillResources(resources)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "metadata": self.metadata.to_dict(),
            "content": self.content,
            "resources": [r.to_dict() for r in self.resources],
        }

    def __repr__(self) -> str:
        return f"Skill(name={self.metadata.name!r}, path={self.path})"


class SkillParseError(Exception):
    """Raised when a skill cannot be parsed."""

    pass
