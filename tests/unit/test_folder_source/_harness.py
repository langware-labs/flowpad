"""Mechanism for the folder-source matrix: changes are filesystem writes.

Content, tokens and the entity assertions live in `_source_fixtures` — shared
with every other source suite, so two matrices cannot drift to different
literals and silently weaken each other. Only the transport is written here.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from flow_sdk.ingest.sync import sync_source

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


async def poll(source) -> None:
    """One full cycle: driver enumerate → reflect → reindex."""
    await sync_source(source)


def write_doc(root: Path, name: str = "a.md", body: str = DOC_BODY) -> Path:
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return p


def write_skill(root: Path, name: str = "alpha") -> Path:
    """A folder-layout asset: a directory whose ``main_file`` is SKILL.md."""
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(SKILL_BODY, encoding="utf-8")
    return folder


@dataclass(frozen=True)
class AssetKind:
    """How to author, revise and locate one kind of asset."""

    name: str
    layout: str  # "file" | "folder" — mirrors TypeInfo.main_layout
    record_type: str  # the type it is INDEXED as — a skill folder is a skill

    def create(self, root: Path) -> Path:
        return write_doc(root) if self.layout == "file" else write_skill(root)

    def revise(self, root: Path) -> None:
        if self.layout == "file":
            (root / "a.md").write_text(DOC_BODY_UPDATED, encoding="utf-8")
        else:
            (root / "alpha" / "SKILL.md").write_text(SKILL_BODY_UPDATED, encoding="utf-8")

    def remove(self, root: Path) -> None:
        if self.layout == "file":
            (root / "a.md").unlink()
        else:
            shutil.rmtree(root / "alpha")

    def rename(self, root: Path) -> None:
        if self.layout == "file":
            (root / "a.md").rename(root / "renamed.md")
        else:
            (root / "alpha").rename(root / "renamed")

    def rel(self, *, renamed: bool = False) -> str:
        """Path of the CONTENT-bearing file, relative to the tree it lives in."""
        if self.layout == "file":
            return "renamed.md" if renamed else "a.md"
        return "renamed/SKILL.md" if renamed else "alpha/SKILL.md"


DOC = AssetKind(name="doc", layout="file", record_type="markdown")
SKILL = AssetKind(name="skill", layout="folder", record_type="skill")
ASSET_KINDS = [DOC, SKILL]
