"""WorkflowRecord — a Record wrapping a markdown workflow file.

Files live at /<project>/workflows/<name>.md — human-readable names,
not UUIDs. The record's name is bootstrapped from the filename stem.
Content is indexed for full-text search.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from typing import Any, ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType


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

    _add(Path.home() / ".claude" / "workflows")

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
    _user_asset: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Workflow"
    index_fields: ClassVar[list[str]] = ["name", "description"]

    # VFS path of the generated pipeline.json (set by the prepare action)
    pipeline_ref: str | None = None

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

    @classmethod
    def from_path(cls, path: Path | str) -> WorkflowRecord:
        """Load a WorkflowRecord from a .md file path."""
        return cls(file_path=path)

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        seen: set[str] = set()
        for workflows_dir in _workflow_search_dirs():
            for md_file in workflows_dir.glob("*.md"):
                seen.add(str(md_file.resolve()))
        count = len(seen)
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_iter(cls, limit: int | None = None) -> Iterator["WorkflowRecord"]:
        seen: set[str] = set()
        count = 0
        for workflows_dir in _workflow_search_dirs():
            for md_file in sorted(workflows_dir.glob("*.md")):
                key = str(md_file.resolve())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    rec = cls(file_path=md_file, id=_workflow_id(md_file))
                    yield rec
                    count += 1
                    if limit is not None and count >= limit:
                        return
                except Exception:
                    continue
