"""ClaudeCommandFsRecord — represents a custom slash command.

Source: ~/.claude/commands/<name>.md (user-level) or .claude/commands/<name>.md (project-level)
Each file is a markdown prompt template invoked via /<name>.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record import Scope


def _command_search_dirs() -> list[tuple[Path, str]]:
    """Return (directory, scope) pairs for command discovery."""
    dirs: list[tuple[Path, str]] = []
    seen: set[str] = set()

    def _add(p: Path, scope: str) -> None:
        rp = str(p.resolve())
        if rp not in seen and p.is_dir():
            seen.add(rp)
            dirs.append((p, scope))

    _add(Path.home() / ".claude" / "commands", "user")
    _add(Path(os.getcwd()) / ".claude" / "commands", "project")
    return dirs


class ClaudeCommandFsRecord(Record):
    """A custom Claude Code slash command.

    Mapped from ``commands/<name>.md``.
    """

    _record_type: ClassVar[str] = RecordType.COMMAND
    _indexed_by_default: ClassVar[bool] = True

    @property
    def source_path(self) -> str:
        return self.source_file or ""

    @property
    def search_title(self) -> str | None:
        return self.name or getattr(self, "command_name", None) or None

    @property
    def search_content(self) -> str | None:
        return getattr(self, "content", None) or None

    def meta_dict(self) -> dict:
        data = super().meta_dict()
        # Include source file path so the entity DB can resolve navigation without a disk lookup
        sf = self.source_file
        if sf:
            data["source_path"] = sf
        return data

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.COMMAND
        kwargs.setdefault("command_name", "")
        kwargs.setdefault("content", "")
        kwargs.setdefault("scope", "user")
        super().__init__(**kwargs)
        if self.command_name:
            scope_val = self.scope.value if hasattr(self.scope, "value") else self.scope
            self.id = f"{scope_val}:{self.command_name}"
            if not self.name:
                self.name = self.command_name
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        count = sum(1 for d, _ in _command_search_dirs() for f in d.glob("*.md") if f.is_file())
        return min(count, limit) if limit is not None else count

    @classmethod
    async def from_fsref(cls, ref) -> list["ClaudeCommandFsRecord"]:
        """Indexer entry point — construct from an FSRef emitted by command_fn."""
        md_file = ref._path
        try:
            content = md_file.read_text(encoding="utf-8")
        except OSError:
            return []
        rec = cls(
            command_name=md_file.stem,
            content=content,
            scope=ref.scope or "user",
        )
        rec.source_file = str(md_file)
        return [rec]

    @classmethod
    def discover_iter(cls, limit: int | None = None, scope: Scope | None = None, **kwargs: Any) -> Iterator[ClaudeCommandFsRecord]:
        scope_filter = scope.value if hasattr(scope, "value") else str(scope) if scope else None
        count = 0
        for commands_dir, dir_scope in _command_search_dirs():
            if scope_filter and dir_scope != scope_filter:
                continue
            for md_file in sorted(commands_dir.glob("*.md")):
                if not md_file.is_file():
                    continue
                try:
                    content = md_file.read_text(encoding="utf-8")
                except OSError:
                    continue
                rec = cls(command_name=md_file.stem, content=content, scope=dir_scope)
                rec.source_file = str(md_file)
                yield rec
                count += 1
                if limit is not None and count >= limit:
                    return

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list[ClaudeCommandFsRecord]:
        """Discover command files from ~/.claude/commands/ and .claude/commands/."""
        records: list[ClaudeCommandFsRecord] = []
        scope_filter = scope.value if hasattr(scope, "value") else str(scope) if scope else None

        for commands_dir, dir_scope in _command_search_dirs():
            if scope_filter and dir_scope != scope_filter:
                continue
            for md_file in sorted(commands_dir.glob("*.md")):
                if not md_file.is_file():
                    continue
                command_name = md_file.stem
                try:
                    content = md_file.read_text(encoding="utf-8")
                except OSError:
                    continue
                rec = cls(
                    command_name=command_name,
                    content=content,
                    scope=dir_scope,
                )
                rec.source_file = str(md_file)
                records.append(rec)
        return records

    @classmethod
    def discover_one(cls, uid: str, **kwargs: Any) -> ClaudeCommandFsRecord | None:
        for r in cls.discover():
            if r.id == uid or r.name == uid:
                return r
        return None
