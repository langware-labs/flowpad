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

from .._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


def _mem_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


def _read_memory_frontmatter_id(path: Path) -> str | None:
    """Return `id` (or legacy `asset_id`) from frontmatter, or None."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    raw = fields.get("id") or fields.get("asset_id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


class ClaudeMemoryRecord(Record):
    """A Claude Code auto-memory markdown file.

    Mapped from ``~/.claude/projects/<encoded>/memory/*.md``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_MEMORY
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Brain"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(
        cls, path: Path, project_path: str = "", project_encoded: str = ""
    ) -> "ClaudeMemoryRecord":
        mem_id = _read_memory_frontmatter_id(path) or _mem_id(path)
        rec = cls(
            id=mem_id,
            name=path.stem,
            asset_type="memory",
            project_path=project_path,
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
    def _from_fsref_sync(cls, ref) -> list["ClaudeMemoryRecord"]:
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

    @classmethod
    def getId(cls, ref) -> str:
        """Read-only: prefer frontmatter `id` (or legacy `asset_id`); else uuid5(path)."""
        existing = _read_memory_frontmatter_id(ref._path)
        return existing if existing else _mem_id(ref._path)

    @classmethod
    def genId(cls, ref) -> str:
        """Read existing id, or mint+write a stable one into the frontmatter.

        Idempotent. Preserves the existing derived id (uuid5 of path) — see
        ``MarkdownRecord.genId`` for the same migration semantics.
        """
        existing = _read_memory_frontmatter_id(ref._path)
        if existing:
            return existing
        new_id = _mem_id(ref._path)
        try:
            text = ref._path.read_text(encoding="utf-8")
        except OSError:
            return new_id
        fm = _extract_frontmatter(text)
        body = _extract_body(text)
        fields: dict = {}
        if fm:
            parsed = _yaml_load(fm)
            if isinstance(parsed, dict):
                fields.update(parsed)
        merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
        try:
            ref._path.write_text(
                _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
                encoding="utf-8",
            )
        except OSError:
            pass
        return new_id

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()

