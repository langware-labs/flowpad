"""ClaudeRulesRecord — represents a Claude Code rules file.

Sources:
- ~/.claude/rules/*.md       (user-level rules)
- <project>/.claude/rules/*.md  (project-level rules, via encoded project dirs)
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef

def _rule_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


class ClaudeRulesRecord(Record):
    """A Claude Code rules markdown file.

    Mapped from ``~/.claude/rules/*.md`` or ``<project>/.claude/rules/*.md``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_RULES
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _icon: ClassVar[str] = "Shield"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(
        cls, path: Path, scope: str = "user"
    ) -> "ClaudeRulesRecord":
        rec = cls(
            id=_rule_id(path),
            name=path.stem,
            asset_type="rule",
            scope=scope,
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
    async def from_fsref(cls, ref) -> list["ClaudeRulesRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_rules_fn."""
        return [cls._from_md_file(ref._path, scope=ref.scope or "user")]

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()
