"""ClaudePlanRecord — represents a saved Claude Code session plan.

Source: ~/.claude/plans/<slug>.md
Markdown files containing implementation plans generated during plan mode.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import ClassVar, Iterator

import os
from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef


def _plan_search_dirs() -> list[Path]:
    """Return directories to scan for plan .md files.

    Scans user-level (~/.claude/plans), all known Claude projects
    (<project>/.claude/plans), cwd-level, and any extra dirs from
    FLOWPAD_PLAN_DIRS (colon-separated).
    """
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    _add(Path.home() / ".claude" / "plans")

    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for real in iter_claude_project_paths():
        _add(real / ".claude" / "plans")

    _add(Path(os.getcwd()) / ".claude" / "plans")

    for extra in os.environ.get("FLOWPAD_PLAN_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs


def _extract_name_from_markdown(text: str) -> str | None:
    """Return first non-empty line with leading '#' and whitespace stripped."""
    for line in text.splitlines():
        stripped = line.lstrip("#").strip()
        if stripped:
            return stripped
    return None


def _plan_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


class ClaudePlanRecord(Record):
    """A saved Claude Code session plan backed by a single .md file.

    Mapped from ``~/.claude/plans/<slug>.md``.
    """

    _record_type: ClassVar[str] = RecordType.PLAN
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _icon: ClassVar[str] = "FileText"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(cls, path: Path) -> "ClaudePlanRecord":
        name = path.stem
        try:
            text = path.read_text(encoding="utf-8")
            heading = _extract_name_from_markdown(text)
            if heading:
                name = heading
        except OSError:
            pass
        rec = cls(
            id=_plan_id(path),
            name=name,
            asset_type="plan",
        )
        object.__setattr__(rec, "_asset_ref", FSRef(path))
        return rec

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_content(self) -> str | None:
        """Full markdown text, used for FTS indexing."""
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None and ar.exists():
            try:
                return ar.read()
            except OSError:
                return None
        src = self.source_file
        if not src:
            return None
        p = Path(src)
        if not p.exists():
            return None
        try:
            return p.read_text(encoding="utf-8")
        except OSError:
            return None

    def compute_record_hash(self) -> str:
        """SHA256 of the markdown file's mtime + size (16 hex chars)."""
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None and ar.exists():
            try:
                st = Path(ar.path).stat()
                payload = f"{st.st_mtime}:{st.st_size}"
                return hashlib.sha256(payload.encode()).hexdigest()[:16]
            except OSError:
                return "0" * 16
        src = self.source_file
        if not src:
            return "0" * 16
        p = Path(src)
        try:
            st = p.stat()
            payload = f"{st.st_mtime}:{st.st_size}"
            return hashlib.sha256(payload.encode()).hexdigest()[:16]
        except OSError:
            return "0" * 16

    @classmethod
    async def from_fsref(cls, ref) -> list["ClaudePlanRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_plan_fn."""
        return [cls._from_md_file(ref._path)]

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()


# Backward-compat alias
ClaudePlanFsRecord = ClaudePlanRecord
