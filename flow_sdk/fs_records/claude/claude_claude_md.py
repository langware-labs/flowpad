"""ClaudeMdFsRecord — represents a CLAUDE.md instruction file.

Sources:
- ~/.claude/CLAUDE.md           (user-level)
- ~/.claude/CLAUDE.local.md     (user-local)
- <project>/CLAUDE.md           (project-level, via encoded dirs)
- <project>/.claude/CLAUDE.md   (project-level alternate location)
- <project>/CLAUDE.local.md     (project-local)
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef

_CLAUDE_HOME = Path.home() / ".claude"
_CLAUDE_PROJECTS = _CLAUDE_HOME / "projects"


def _md_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


class ClaudeMdFsRecord(Record):
    """A CLAUDE.md instruction file.

    Mapped from ``CLAUDE.md``, ``CLAUDE.local.md``, or ``.claude/CLAUDE.md``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_MD
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(cls, path: Path, scope: str = "project") -> "ClaudeMdFsRecord":
        rec = cls(
            id=_md_id(path),
            name=path.name,
            asset_type="claude_md",
            scope=scope,
            file_path=str(path),
            filename=path.name,
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
    def _external_source_iter(cls, limit: int | None = None) -> Iterator["ClaudeMdFsRecord"]:
        count = 0

        # User-level CLAUDE.md files
        for name in ("CLAUDE.md", "CLAUDE.local.md"):
            candidate = _CLAUDE_HOME / name
            if candidate.is_file():
                yield cls._from_md_file(candidate, scope="user")
                count += 1
                if limit is not None and count >= limit:
                    return

        # Project-level CLAUDE.md files
        if not _CLAUDE_PROJECTS.is_dir():
            return
        for project_dir in sorted(_CLAUDE_PROJECTS.iterdir()):
            if not project_dir.is_dir():
                continue
            encoded = project_dir.name
            real_path = Path("/" + encoded.lstrip("-").replace("-", "/"))
            for rel in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
                candidate = real_path / rel
                if candidate.is_file():
                    yield cls._from_md_file(candidate, scope="project")
                    count += 1
                    if limit is not None and count >= limit:
                        return

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        count = 0
        for name in ("CLAUDE.md", "CLAUDE.local.md"):
            if (_CLAUDE_HOME / name).is_file():
                count += 1
        if _CLAUDE_PROJECTS.is_dir():
            for project_dir in _CLAUDE_PROJECTS.iterdir():
                if not project_dir.is_dir():
                    continue
                encoded = project_dir.name
                real_path = Path("/" + encoded.lstrip("-").replace("-", "/"))
                for rel in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
                    if (real_path / rel).is_file():
                        count += 1
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_find_one(cls, uid: str) -> "ClaudeMdFsRecord | None":
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

