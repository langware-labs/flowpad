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

from .._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


def _rule_id(path: Path) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


def _read_rules_frontmatter_id(path: Path) -> str | None:
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


class ClaudeRulesRecord(Record):
    """A Claude Code rules markdown file.

    Mapped from ``~/.claude/rules/*.md`` or ``<project>/.claude/rules/*.md``.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_RULES
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Shield"
    index_fields: ClassVar[list[str]] = ["name"]

    @classmethod
    def _from_md_file(
        cls, path: Path, scope: str = "user"
    ) -> "ClaudeRulesRecord":
        rule_id = _read_rules_frontmatter_id(path) or _rule_id(path)
        rec = cls(
            id=rule_id,
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
    def _from_fsref_sync(cls, ref) -> list["ClaudeRulesRecord"]:
        """Indexer entry point — construct from an FSRef emitted by claude_rules_fn."""
        return [cls._from_md_file(ref._path, scope=ref.scope or "user")]

    @classmethod
    def getId(cls, ref) -> str:
        """Read-only: prefer frontmatter `id` (or legacy `asset_id`); else uuid5(path)."""
        existing = _read_rules_frontmatter_id(ref._path)
        return existing if existing else _rule_id(ref._path)

    @classmethod
    def genId(cls, ref) -> str:
        """Read existing id, or mint+write a stable one into the frontmatter.

        Idempotent. Preserves the existing derived id (uuid5 of path) — see
        ``MarkdownRecord.genId`` for the same migration semantics.
        """
        existing = _read_rules_frontmatter_id(ref._path)
        if existing:
            return existing
        new_id = _rule_id(ref._path)
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
