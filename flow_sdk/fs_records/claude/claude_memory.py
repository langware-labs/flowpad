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
    async def from_fsref(cls, ref) -> list["ClaudeMemoryRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_memory_fn.

        ref._path is `<encoded_project_dir>/memory/<name>.md`. The parent
        FSRef (PROJECT) carries the encoded dir name; the decoded cwd is
        read from a session JSONL in that dir.
        """
        from flow_sdk.fs_records._claude_projects import _real_path_from_jsonl
        md_path = ref._path
        # encoded project dir: md_path.parent is `memory/`, .parent.parent is the encoded dir
        project_dir = md_path.parent.parent
        encoded = project_dir.name
        real_path = _real_path_from_jsonl(project_dir)
        real = str(real_path) if real_path else "/" + encoded.lstrip("-").replace("-", "/")
        return [cls._from_md_file(md_path, project_path=real, project_encoded=encoded)]

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()

