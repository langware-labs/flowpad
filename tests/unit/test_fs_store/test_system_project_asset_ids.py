"""Wheel-shipped assets must carry a valid capsule id — enforced at CI time.

A system-project agent/skill ships inside the wheel. If its frontmatter ``id:``
is missing or invalid (the ``id: vibe`` incident), every install triggers the
mint-on-miss policy: the indexer writes a fresh v4 into the INSTALLED copy,
which the next reinstall resets — one duplicate entity row per install. Baking
a valid v4/v5 into the repo file makes every install adopt the same id and the
mint path never fires. This guard makes shipping an invalid capsule id a test
failure instead of a slow DB leak.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.config import system_projects_root
from tests.unit.test_fs_store._md_harness import fm_id as _fm_id

_SYSTEM_PROJECTS = system_projects_root()


def _capsule_files() -> list[Path]:
    """Every wheel-shipped file the indexer adopts an entity id from:
    ``.claude/agents/*.md`` plus ``.claude/skills/*/SKILL.md``."""
    files = sorted(_SYSTEM_PROJECTS.glob("*/.claude/agents/*.md"))
    files += sorted(_SYSTEM_PROJECTS.glob("*/.claude/skills/*/SKILL.md"))
    return files


def _skill_capsule_snapshots() -> list[tuple[Path, str | None, str | None]]:
    """Freeze shipped skill ids before any test can backfill ``.flow/id``."""
    snapshots: list[tuple[Path, str | None, str | None]] = []
    for path in sorted(_SYSTEM_PROJECTS.glob("*/.claude/skills/*/SKILL.md")):
        frontmatter_id = _fm_id(path)
        capsule_path = path.parent / ".flow" / "id"
        capsule_id = (
            capsule_path.read_text(encoding="utf-8").strip()
            if capsule_path.is_file()
            else None
        )
        snapshots.append(
            (
                path,
                str(frontmatter_id) if frontmatter_id is not None else None,
                capsule_id,
            )
        )
    return snapshots


_SKILL_CAPSULE_SNAPSHOTS = _skill_capsule_snapshots()


def test_capsule_file_set_is_nonempty() -> None:
    assert _capsule_files(), f"no system-project assets found under {_SYSTEM_PROJECTS}"


@pytest.mark.parametrize("path", _capsule_files(), ids=lambda p: str(p.relative_to(_SYSTEM_PROJECTS)))
def test_system_asset_ships_valid_capsule_id(path: Path) -> None:
    raw = _fm_id(path)
    assert raw is not None, (
        f"{path.name} ships without a frontmatter id: — every install would "
        f"mint a fresh one (duplicate entity row per install). Bake in a v4."
    )
    assert is_valid_entity_id(str(raw)), (
        f"{path.name} ships id: {raw!r}, which is not a valid v4/v5 entity id — "
        f"the indexer rejects it and mints a fresh id on every install. Bake in a v4."
    )


@pytest.mark.parametrize(
    ("path", "frontmatter_id", "capsule_id"),
    _SKILL_CAPSULE_SNAPSHOTS,
    ids=[
        str(path.relative_to(_SYSTEM_PROJECTS))
        for path, _frontmatter_id, _capsule_id in _SKILL_CAPSULE_SNAPSHOTS
    ],
)
def test_system_skill_ships_matching_folder_capsule_id(
    path: Path,
    frontmatter_id: str | None,
    capsule_id: str | None,
) -> None:
    capsule_path = path.parent / ".flow" / "id"
    assert capsule_id is not None, (
        f"{path.relative_to(_SYSTEM_PROJECTS)} ships without {capsule_path.name!r} "
        "folder identity; an index pass could mutate or remint the installed asset."
    )
    assert frontmatter_id is not None, f"{path.name} ships without a frontmatter id"
    assert is_valid_entity_id(frontmatter_id), (
        f"{path.name} frontmatter id {frontmatter_id!r} is not a valid v4/v5 entity id"
    )
    assert is_valid_entity_id(capsule_id), (
        f"{capsule_path} contains {capsule_id!r}, not a valid v4/v5 entity id"
    )
    assert capsule_id == frontmatter_id, (
        f"{capsule_path} id {capsule_id!r} does not match "
        f"{path.name} frontmatter id {frontmatter_id!r}"
    )
