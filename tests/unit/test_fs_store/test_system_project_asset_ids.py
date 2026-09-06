"""Wheel-shipped assets must carry a valid frontmatter id — enforced at CI time.

A system-project agent/skill ships inside the wheel. If its frontmatter ``id:``
is missing or invalid (the ``id: vibe`` incident), every install triggers the
mint-on-miss policy: the indexer writes a fresh v4 into the INSTALLED copy,
which the next reinstall resets — one duplicate entity row per install. Baking
a valid v4/v5 into the repo file makes every install adopt the same id and the
mint path never fires. This guard makes shipping an invalid capsule id a test
failure instead of a slow DB leak. Shipped folder assets (journeys) carry
their id in the live json capsule; no retired ``.flow/id`` ships.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.capsules.folder import FolderCapsule
from flow_sdk.config import system_projects_root
from tests.unit.test_fs_store._md_harness import fm_id as _fm_id

_SYSTEM_PROJECTS = system_projects_root()


def _capsule_files() -> list[Path]:
    """Every wheel-shipped file the indexer adopts an entity id from:
    ``.claude/agents/*.md`` plus ``.claude/skills/*/SKILL.md``."""
    files = sorted(_SYSTEM_PROJECTS.glob("*/.claude/agents/*.md"))
    files += sorted(_SYSTEM_PROJECTS.glob("*/.claude/skills/*/SKILL.md"))
    return files



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


def test_no_retired_flow_id_ships() -> None:
    """A ``.flow/id`` is a retired form: it reads as foreign and would leave
    every install re-minting the asset."""
    assert sorted(_SYSTEM_PROJECTS.rglob(".flow/id")) == []


@pytest.mark.parametrize(
    "folder",
    sorted(p.parents[2] for p in _SYSTEM_PROJECTS.glob("*/agentic-assets/*/*/.flow/capsules/identity.json")),
    ids=lambda p: str(p.relative_to(_SYSTEM_PROJECTS)),
)
def test_shipped_folder_asset_carries_a_valid_live_id(folder: Path) -> None:
    data = FolderCapsule(folder).read("identity")
    assert data is not None and is_valid_entity_id(data.data.get("id")), folder
