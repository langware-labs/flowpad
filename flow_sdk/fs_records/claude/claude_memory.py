"""ClaudeMemoryRecord — represents a Claude Code auto-memory file.

Source: ~/.claude/projects/<encoded>/memory/*.md
These are auto-memory markdown files written by Claude Code during sessions.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef

_CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def _mem_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


class ClaudeMemoryRecord(Record):
    """A Claude Code auto-memory markdown file.

    Mapped from ``~/.claude/projects/<encoded>/memory/*.md``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_MEMORY
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _icon: ClassVar[str] = "Brain"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(
        cls, path: Path, project_path: str = "", project_encoded: str = ""
    ) -> "ClaudeMemoryRecord":
        rec = cls(
            id=_mem_id(path),
            name=path.stem,
            asset_type="memory",
            project_path=project_path,
            project_encoded=project_encoded,
        )
        object.__setattr__(rec, "_asset_ref", FSRef(path))
        return rec

    @property
    def search_content(self) -> str | None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is None or not ar.exists():
            return None
        try:
            return ar.read()
        except OSError:
            return None

    @classmethod
    def _external_source_iter(
        cls, limit: int | None = None
    ) -> Iterator["ClaudeMemoryRecord"]:
        if not _CLAUDE_PROJECTS.is_dir():
            return
        from flow_sdk.fs_records._claude_projects import _real_path_from_jsonl
        count = 0
        for project_dir in sorted(_CLAUDE_PROJECTS.iterdir()):
            if not project_dir.is_dir():
                continue
            mem_dir = project_dir / "memory"
            if not mem_dir.is_dir():
                continue
            encoded = project_dir.name
            real_path = _real_path_from_jsonl(project_dir)
            real = str(real_path) if real_path else "/" + encoded.lstrip("-").replace("-", "/")
            for md_file in sorted(mem_dir.glob("*.md")):
                yield cls._from_md_file(md_file, project_path=real, project_encoded=encoded)
                count += 1
                if limit is not None and count >= limit:
                    return

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        if not _CLAUDE_PROJECTS.is_dir():
            return 0
        count = 0
        for project_dir in _CLAUDE_PROJECTS.iterdir():
            if not project_dir.is_dir():
                continue
            mem_dir = project_dir / "memory"
            if mem_dir.is_dir():
                count += sum(1 for _ in mem_dir.glob("*.md"))
        return min(count, limit) if limit is not None else count

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        # discover_iter deduplicates: external records already on disk are skipped.
        # The unique count is max(disk, ext), not disk + ext.
        ext = cls._external_source_count()
        base = super().discovery_items_count()  # type: ignore[misc]  # disk + ext (no limit)
        disk = max(0, base - ext)
        count = max(disk, ext)
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_find_one(cls, uid: str) -> "ClaudeMemoryRecord | None":
        for rec in cls._external_source_iter():
            if rec.id == uid:
                return rec
        return None

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()

    @property
    def source_path(self) -> str:
        ar = object.__getattribute__(self, "_asset_ref")
        return ar.path if ar is not None else ""

