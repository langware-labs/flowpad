"""Entity classes for markdown-file-backed records.

Hierarchy:
    Markdown          — base for all markdown-backed types
    ├── Docs          — wiki/documentation .md files (type="markdown")
    ├── ClaudeMemory  — auto-memory files (type="claude_memory")
    ├── ClaudeRules   — rules files (type="claude_rules")
    ├── ClaudePlan    — plan files (type="plan")
    └── ClaudeMd      — CLAUDE.md files (type="claude_md")
"""

from typing import ClassVar, List, Optional, Type

from pydantic import BaseModel

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core.entity.context_data_schemas import (
    ClaudeMdContextData,
    MarkdownContextData,
    PlanContextData,
)
from flow_sdk.fs_store.fs_ref.base import FSRef


class Translation(BaseModel):
    """One translated copy of a markdown asset's primary doc.

    A translation is NOT a separate entity — it is an alternate body file of the
    same asset, living under the asset's record-data folder at
    ``translations/<lang>.md`` (see ``flow_sdk/fs_store/operations/translation.py``).
    The UI selects it inline via the ``?lang=<code>`` dock prop (same tab,
    ``DockPointer.options`` are excluded from tab identity).

    Fields:
      * ``lang``       — BCP-47-ish target code (``es``, ``he``, ``fr-CA`` …); the
                         ``?lang=`` dock-prop value and the ``<lang>.md`` filename.
      * ``ref``        — FSRef to the translated file, so the frontend never
                         computes a records_data path (it reads the ref directly).
      * ``process_id`` — the launching translator worker; status ("translating"
                         vs "ready") is DERIVED from this process, not stored.
    """

    lang: str
    ref: FSRef
    process_id: Optional[str] = None


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
    # Translated copies of this doc's primary body. Each entry points at a
    # ``translations/<lang>.md`` file under the record-data folder; the UI lists
    # them in the Translations side panel and swaps the editor body inline via
    # the ``?lang=`` dock prop. Appended by the ``add_translation`` action.
    translations: List[Translation] = APIField(default_factory=list)
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
    # Dot-taxonomy subjects this doc is ABOUT (frontmatter `topics:` list,
    # canonical topic names). The doc→topic edge for `flow topic get` — the
    # doc points at the topic, never the reverse (docs/topics.md).
    topics: List[str] = APIField(default_factory=list)


class ClaudeMemory(Markdown):
    type: str = APIField(default="claude_memory")
    asset_type: str = APIField(default="memory")
    project_path: str = APIField(default="")


class ClaudeRules(Markdown):
    type: str = APIField(default="claude_rules")
    asset_type: str = APIField(default="rule")


class ClaudePlan(Markdown):
    type: str = APIField(default="plan")
    asset_type: str = APIField(default="plan")
    context_data_schema: ClassVar[Type] = PlanContextData


class ClaudeMd(Markdown):
    type: str = APIField(default="claude_md")
    asset_type: str = APIField(default="claude_md")
    file_path: str = APIField(default="")
    filename: str = APIField(default="")
    context_data_schema: ClassVar[Type] = ClaudeMdContextData
