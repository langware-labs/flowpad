"""Entity classes for Claude Code memory, plan, rules, and CLAUDE.md records."""

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class ClaudeMemory(Entity):
    type: str = APIField(default="claude_memory")
    name: str = APIField(default="")
    asset_type: str = APIField(default="memory")
    project_path: str = APIField(default="")
    project_encoded: str = APIField(default="")
    source_path: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Brain"


class ClaudeRules(Entity):
    type: str = APIField(default="claude_rules")
    name: str = APIField(default="")
    asset_type: str = APIField(default="rule")
    scope: str = APIField(default="user")
    source_path: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Shield"


class ClaudePlan(Entity):
    type: str = APIField(default="plan")
    name: str = APIField(default="")
    asset_type: str = APIField(default="plan")
    source_path: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "FileText"


class ClaudeMd(Entity):
    type: str = APIField(default="claude_md")
    name: str = APIField(default="")
    asset_type: str = APIField(default="claude_md")
    scope: str = APIField(default="project")
    file_path: str = APIField(default="")
    filename: str = APIField(default="")
    source_path: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
