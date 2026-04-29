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
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef

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
    async def from_fsref(cls, ref) -> list["ClaudeMdFsRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_md_*_fn."""
        return [cls._from_md_file(ref._path, scope=ref.scope or "project")]

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()

