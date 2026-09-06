"""Mechanism for the git-source matrix: changes are commits.

Content, tokens and the entity assertions live in `_source_fixtures`, shared
with the folder suite. Only the transport differs — every CRUD verb here ends
in a commit, so the source observes a diff rather than a directory.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .._source_fixtures import (  # noqa: F401 — re-exported as this suite's surface
    DOC_BODY,
    DOC_BODY_UPDATED,
    FIRST_TOKEN,
    SECOND_TOKEN,
    SKILL_BODY,
    SKILL_BODY_UPDATED,
    entity_at,
    id_at,
    searchable,
)
from .conftest import commit, git


@dataclass(frozen=True)
class AssetKind:
    name: str
    layout: str  # "file" | "folder" — mirrors the TypeInfo shape kind (File | Folder)
    record_type: str  # the type it is INDEXED as — a skill folder is a skill

    def create(self, repo: Path) -> None:
        if self.layout == "file":
            (repo / "a.md").write_text(DOC_BODY, encoding="utf-8")
        else:
            (repo / "alpha").mkdir(parents=True, exist_ok=True)
            (repo / "alpha" / "SKILL.md").write_text(SKILL_BODY, encoding="utf-8")
        commit(repo, f"add {self.name}")

    def revise(self, repo: Path) -> None:
        if self.layout == "file":
            (repo / "a.md").write_text(DOC_BODY_UPDATED, encoding="utf-8")
        else:
            (repo / "alpha" / "SKILL.md").write_text(SKILL_BODY_UPDATED, encoding="utf-8")
        commit(repo, f"revise {self.name}")

    def rename(self, repo: Path) -> None:
        """``git mv``, so the transport reports a RENAME rather than a pair."""
        if self.layout == "file":
            git(repo, "mv", "a.md", "renamed.md")
        else:
            git(repo, "mv", "alpha", "renamed")
        commit(repo, f"rename {self.name}")

    def remove(self, repo: Path) -> None:
        git(repo, "rm", "-r", "-q", "a.md" if self.layout == "file" else "alpha")
        commit(repo, f"delete {self.name}")

    def rel(self, *, renamed: bool = False) -> str:
        if self.layout == "file":
            return "renamed.md" if renamed else "a.md"
        return "renamed/SKILL.md" if renamed else "alpha/SKILL.md"


DOC = AssetKind(name="doc", layout="file", record_type="markdown")
SKILL = AssetKind(name="skill", layout="folder", record_type="skill")
ASSET_KINDS = [DOC, SKILL]
