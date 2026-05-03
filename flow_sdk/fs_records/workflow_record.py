"""WorkflowRecord — a Record wrapping a markdown workflow file.

Files live at /<project>/workflows/<name>.md — human-readable names,
not UUIDs. The record's name is bootstrapped from the filename stem.
Content is indexed for full-text search.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.instance_settings import get_instance_settings

from ._frontmatter import _extract_frontmatter, _render_frontmatter, _yaml_load


def _read_workflow_asset_id(path: Path) -> str | None:
    """Return ``asset_id`` from frontmatter, or None if absent / unreadable."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    raw = fields.get("asset_id") or fields.get("id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


def _workflow_search_dirs() -> list[Path]:
    """Return directories to scan for workflow .md files.

    Scans user-level (~/.claude/workflows), all known Claude projects
    (<project>/.claude/workflows), cwd-level, and any extra dirs from
    FLOWPAD_WORKFLOW_DIRS (colon-separated).
    """
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    _add(get_instance_settings().claude_workflows_dir)

    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for real in iter_claude_project_paths():
        _add(real / ".claude" / "workflows")

    _add(Path(os.getcwd()) / ".claude" / "workflows")

    for extra in os.environ.get("FLOWPAD_WORKFLOW_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs


def _workflow_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


class WorkflowRecord(Record):
    """A record backed by a markdown workflow file."""

    _record_type: ClassVar[str] = RecordType.WORKFLOW
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Workflow"
    index_fields: ClassVar[list[str]] = ["name", "description"]

    # Framework upsert: <scope_root>/.claude/workflows/<safe_name>.md
    _main_subdir: ClassVar[str] = ".claude/workflows"
    _main_layout: ClassVar[str] = "file"

    @property
    def main_ref(self) -> "Any":  # FrontMatterFsRef | None
        """Primary content ref points at the workflow .md via asset_ref."""
        from flow_sdk.fs_store.fs_ref import FrontMatterFsRef
        ar = self.asset_ref
        if ar is not None:
            return FrontMatterFsRef(ar._path)
        return None

    def default_body(self, entity) -> "str | None":
        """Stub for new workflows. Only fires when the file at the computed
        asset_ref doesn't yet exist. Shadow guard in Record.upsert_main_ref
        refuses writes inside the shadow tree."""
        name = (getattr(entity, "name", None) or "").strip() or "Untitled"
        desc = (getattr(entity, "description", None) or "").strip()
        fm: dict = {"asset_id": entity.id, "name": name}
        if desc:
            fm["description"] = desc
        return _render_frontmatter(fm) + f"\n# {name}\n"

    def __init__(self, file_path: Path | str | None = None, **kwargs: Any):
        kwargs.setdefault("type", RecordType.WORKFLOW)
        if file_path is not None:
            file_path = Path(file_path)
            kwargs.setdefault("name", file_path.stem)
        super().__init__(**kwargs)
        if file_path is not None:
            # Use asset_ref instead of _file_path instance attr
            from flow_sdk.fs_store.fs_ref import FSRef
            object.__setattr__(self, "_asset_ref", FSRef(file_path))

    @property
    def file_path(self) -> Path:
        ar = self.asset_ref
        if ar is not None:
            return ar._path
        raise AttributeError("WorkflowRecord has no file_path set")

    @property
    def search_content(self) -> str | None:
        """Markdown content for FTS indexing."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return ar.read()
        return None

    def meta_dict(self) -> dict:
        result = super().meta_dict()
        ar = self.asset_ref
        if ar is not None:
            result["asset_ref"] = str(ar._path)
        return result

    @classmethod
    def from_path(cls, path: Path | str) -> WorkflowRecord:
        """Load a WorkflowRecord from a .md file path."""
        return cls(file_path=path)

    @classmethod
    async def from_fsref(cls, ref) -> list["WorkflowRecord"]:
        """Indexer entry point — construct from an FSRef emitted by workflow_fn.

        Honors ``asset_id`` from frontmatter when present so that workflows
        created via ``Entity.save()`` keep the same id on subsequent rescans
        (avoiding duplicate Records). Falls back to ``uuid5(path)`` for
        legacy files written without an asset_id stamp.
        """
        return [cls(file_path=ref._path, id=cls.getId(ref))]

    @classmethod
    def getId(cls, ref) -> str:
        """Mirror ``from_fsref``: prefer frontmatter ``asset_id``, else uuid5(path)."""
        existing = _read_workflow_asset_id(ref._path)
        return existing if existing else _workflow_id(ref._path)
