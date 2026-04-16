"""Entity classes for markdown-file-backed records.

Hierarchy:
    Markdown          — base for all markdown-backed types
    ├── Docs          — wiki/documentation .md files (type="markdown")
    ├── ClaudeMemory  — auto-memory files (type="claude_memory")
    ├── ClaudeRules   — rules files (type="claude_rules")
    ├── ClaudePlan    — plan files (type="plan")
    └── ClaudeMd      — CLAUDE.md files (type="claude_md")
"""

from typing import ClassVar, List

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Markdown(Entity):
    """Base entity for all markdown-file-backed record types.

    Fields common to docs, plan, claude_memory, claude_md, claude_rules.
    """

    name: str = APIField(default="")
    asset_type: str = APIField(default="")
    source_path: str = APIField(default="")
    status: str = APIField(default="")
    _api_visible: ClassVar[bool] = True


class Docs(Markdown):
    type: str = APIField(default="markdown")
    title: str = APIField(default="")
    tags: List[str] = APIField(default_factory=list)
    links: List[str] = APIField(default_factory=list)
    scope: str = APIField(default="")
    _icon: ClassVar[str] = "BookOpen"


class ClaudeMemory(Markdown):
    type: str = APIField(default="claude_memory")
    asset_type: str = APIField(default="memory")
    project_path: str = APIField(default="")
    project_encoded: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Brain"


class ClaudeRules(Markdown):
    type: str = APIField(default="claude_rules")
    asset_type: str = APIField(default="rule")
    scope: str = APIField(default="user")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Shield"


class ClaudePlan(Markdown):
    type: str = APIField(default="plan")
    asset_type: str = APIField(default="plan")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "FileText"


class ClaudeMd(Markdown):
    type: str = APIField(default="claude_md")
    asset_type: str = APIField(default="claude_md")
    scope: str = APIField(default="project")
    file_path: str = APIField(default="")
    filename: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
