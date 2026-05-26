"""Entity classes for markdown-file-backed records.

Hierarchy:
    Markdown          — base for all markdown-backed types
    ├── Docs          — wiki/documentation .md files (type="markdown")
    ├── ClaudeMemory  — auto-memory files (type="claude_memory")
    ├── ClaudeRules   — rules files (type="claude_rules")
    ├── ClaudePlan    — plan files (type="plan")
    └── ClaudeMd      — CLAUDE.md files (type="claude_md")
"""

from typing import ClassVar, List, Type

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core.entity.context_data_schemas import (
    ClaudeMdContextData,
    MarkdownContextData,
    PlanContextData,
)


class Markdown(Entity):
    """Base entity for all markdown-file-backed record types.

    Fields common to docs, plan, claude_memory, claude_md, claude_rules.
    """

    _abstract: ClassVar[bool] = True
    name: str = APIField(default="")
    asset_type: str = APIField(default="")
    asset_ref: str = APIField(default="")
    status: str = APIField(default="")
    # Folder-containment fields (populated at index time by MarkdownRecord.from_markdown).
    # parent_path is the immediate containing directory; vault_root is the scan root.
    # These power the Obsidian-style Wiki folder tree in the UI.
    parent_path: str = APIField(default="")
    vault_root: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    # Sidecar shape when another entity puts a `markdown-<id>` /
    # `claude_memory-<id>` / `claude_rules-<id>` / `docs-<id>` reference in
    # its context bucket. The carried path lets the dock loader self-heal
    # a 404 by single-file-indexing this markdown file.
    context_data_schema: ClassVar[Type] = MarkdownContextData


class Docs(Markdown):
    type: str = APIField(default="markdown")
    title: str = APIField(default="")
    tags: List[str] = APIField(default_factory=list)
    links: List[str] = APIField(default_factory=list)
    _icon: ClassVar[str] = "BookOpen"


class ClaudeMemory(Markdown):
    type: str = APIField(default="claude_memory")
    asset_type: str = APIField(default="memory")
    project_path: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Brain"


class ClaudeRules(Markdown):
    type: str = APIField(default="claude_rules")
    asset_type: str = APIField(default="rule")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Shield"


class ClaudePlan(Markdown):
    type: str = APIField(default="plan")
    asset_type: str = APIField(default="plan")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "FileText"
    context_data_schema: ClassVar[Type] = PlanContextData


class ClaudeMd(Markdown):
    type: str = APIField(default="claude_md")
    asset_type: str = APIField(default="claude_md")
    file_path: str = APIField(default="")
    filename: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
    context_data_schema: ClassVar[Type] = ClaudeMdContextData
