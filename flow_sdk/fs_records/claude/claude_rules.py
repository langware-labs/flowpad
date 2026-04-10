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

_CLAUDE_HOME = Path.home() / ".claude"
_CLAUDE_PROJECTS = _CLAUDE_HOME / "projects"


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
    def _external_source_iter(
        cls, limit: int | None = None
    ) -> Iterator["ClaudeRulesRecord"]:
        count = 0

        # User-level rules: ~/.claude/rules/*.md
        user_rules_dir = _CLAUDE_HOME / "rules"
        if user_rules_dir.is_dir():
            for md_file in sorted(user_rules_dir.glob("*.md")):
                yield cls._from_md_file(md_file, scope="user")
                count += 1
                if limit is not None and count >= limit:
                    return

        # Project-level rules: <real_project>/.claude/rules/*.md
        from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
        for real_path in iter_claude_project_paths():
            rules_dir = real_path / ".claude" / "rules"
            if not rules_dir.is_dir():
                continue
            for md_file in sorted(rules_dir.glob("*.md")):
                yield cls._from_md_file(md_file, scope="project")
                count += 1
                if limit is not None and count >= limit:
                    return

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        count = 0
        user_rules_dir = _CLAUDE_HOME / "rules"
        if user_rules_dir.is_dir():
            count += sum(1 for _ in user_rules_dir.glob("*.md"))
        from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
        for real_path in iter_claude_project_paths():
            rules_dir = real_path / ".claude" / "rules"
            if rules_dir.is_dir():
                count += sum(1 for _ in rules_dir.glob("*.md"))
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_find_one(cls, uid: str) -> "ClaudeRulesRecord | None":
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
