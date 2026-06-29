"""Unit tests for ``entity.frontmatter`` get/set — real entity + real files, no mocks.

Exercises the accessor against a real ``Skill`` entity whose ``asset_ref`` points
at a temp skill folder, proving read-through ``get`` and write-through merge ``set``
preserve the body and unrelated frontmatter keys (the ``version`` round-trip the
asset-versioning feature depends on).
"""

from pathlib import Path

import pytest

from flow_sdk.builtin.skill import Skill
from flow_sdk.fs_store.indexer._frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.schema.type_info import register_all

SKILL_MD = """---
id: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3
name: slick
description: A code design lens
tags: [design, lint]
---

# slick

Body line one.

Body line two.
"""


@pytest.fixture(scope="module", autouse=True)
def _registry():
    # The SchemaRegistry isn't populated by import alone under pytest; register
    # so ``type_info.body_path_for`` resolves the skill folder -> SKILL.md.
    register_all()


@pytest.fixture
def skill_entity(tmp_path) -> Skill:
    folder = tmp_path / ".claude" / "skills" / "slick"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    return Skill(asset_ref=str(folder), name="slick")


def test_get_reads_through_to_disk(skill_entity: Skill):
    fm = skill_entity.frontmatter
    assert fm.get("name") == "slick"
    assert fm.get("description") == "A code design lens"
    assert fm.get("tags") == ["design", "lint"]
    assert fm.get("missing", "fallback") == "fallback"
    assert "id" in fm


def test_set_merges_and_preserves_body_and_keys(skill_entity: Skill):
    skill_entity.frontmatter.set("version", 7)
    skill_entity.frontmatter["foo"] = "bar"

    body_path = Path(skill_entity.asset_ref) / "SKILL.md"
    text = body_path.read_text(encoding="utf-8")
    fields = _yaml_load(_extract_frontmatter(text) or "")

    # New keys written.
    assert fields["version"] == 7
    assert fields["foo"] == "bar"
    # Pre-existing keys preserved.
    assert fields["id"] == "9fe9bee3-ce84-58c1-b047-90629fa5dfd3"
    assert fields["name"] == "slick"
    assert fields["description"] == "A code design lens"
    assert fields["tags"] == ["design", "lint"]
    # Body preserved verbatim.
    body = _extract_body(text)
    assert "Body line one." in body
    assert "Body line two." in body
    assert body.startswith("# slick")


def test_set_is_read_back_through_get(skill_entity: Skill):
    skill_entity.frontmatter.set("version", 3)
    assert skill_entity.frontmatter.get("version") == 3
    # A second set overwrites in place, not duplicating the key.
    skill_entity.frontmatter.set("version", 4)
    assert skill_entity.frontmatter.get("version") == 4
