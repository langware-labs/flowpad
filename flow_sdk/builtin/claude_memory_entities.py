"""Entity classes for markdown-file-backed records.

Hierarchy:
    Markdown          — base for all markdown-backed types
    ├── Docs          — wiki/documentation .md files (type="markdown")
    ├── ClaudeMemory  — auto-memory files (type="claude_memory")
    ├── ClaudeRules   — rules files (type="claude_rules")
    ├── ClaudePlan    — plan files (type="plan")
    └── ClaudeMd      — CLAUDE.md files (type="claude_md")
"""

from typing import Any, ClassVar, List, Optional, Type

from pydantic import BaseModel, field_validator

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.context_data_schemas import (
    ClaudeMdContextData,
    MarkdownContextData,
    PlanContextData,
)
from flow_sdk.fs_store.fs_ref.base import FSRef
from flow_sdk.schema.data_spec import Body, FrontMatter


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


class MarkdownSpec(FrontMatter):
    """A ``.md`` document under ``docs/``: the frontmatter keys a doc may
    carry and its markdown ``Body``. ``asset_type``/``title``/``links`` fall
    back to the path and the body (``derive_markdown``)."""

    title: Optional[str] = None
    asset_type: Optional[str] = None
    tags: Optional[List[str]] = None
    links: Optional[List[str]] = None
    scope: Optional[str] = None
    body: Body = ""

    @field_validator("tags", mode="before")
    @classmethod
    def _tags_list(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [t.strip() for t in value.split(",") if t.strip()]
        return value


class ClaudeMdSpec(FrontMatter):
    """A ``CLAUDE.md``: frontmatter is rare; the document is its ``Body``."""

    asset_type: Optional[str] = None
    scope: Optional[str] = None
    body: Body = ""


class Markdown(Entity):
    """Base entity for all markdown-file-backed record types.

    Fields common to docs, plan, claude_memory, claude_md, claude_rules.
    """

    _abstract: ClassVar[bool] = True
    name: str = APIField(default="")
    asset_type: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    status: str = APIField(default="")
    # Folder-containment fields (populated at index time by MarkdownRecord.from_markdown).
    # parent_path is the immediate containing directory; vault_root is the scan root.
    # These power the Obsidian-style Wiki folder tree in the UI.
    # Sender-local placement: never rides a bundle or the hub.
    parent_path: str = APIField(default="", persist=Persist.TRUE, sharing=Sharing.PRIVATE)
    vault_root: str = APIField(default="", persist=Persist.TRUE, sharing=Sharing.PRIVATE)
    # The document text — the serializer's ``Body``. Never a DB column: the
    # file is the source of truth and viewers stream it via FSRef.
    body: str = NoDBAPIField(default="")
    # Translated copies of this doc's primary body. Each entry points at a
    # ``translations/<lang>.md`` file under the record-data folder; the UI lists
    # them in the Translations side panel and swaps the editor body inline via
    # the ``?lang=`` dock prop. Appended by the ``add_translation`` action.
    translations: List[Translation] = APIField(default_factory=list, sharing=Sharing.PRIVATE)  # local sidecars
    _api_visible: ClassVar[bool] = True
    # Sidecar shape when another entity puts a `markdown-<id>` /
    # `claude_memory-<id>` / `claude_rules-<id>` / `docs-<id>` reference in
    # its context bucket. The carried path lets the dock loader self-heal
    # a 404 by single-file-indexing this markdown file.
    context_data_schema: ClassVar[Type] = MarkdownContextData


class Docs(Markdown):
    type: str = APIField(default="markdown")
    title: str = APIField(default="")
    # Hub storage is entity-scoped and canonical, independent of the sender's
    # local asset path. Share-time byte transport publishes this record's main
    # ref under the stable Hub name.
    # OKF-compatible metadata. Values are preserved as authored for
    # storage/search; the tag binding readers independently select and
    # normalize the grammar-valid dot paths used by the taxonomy.
    tags: List[str] = APIField(default_factory=list, sharing=Sharing.PRIVATE)
    links: List[str] = APIField(default_factory=list)


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
