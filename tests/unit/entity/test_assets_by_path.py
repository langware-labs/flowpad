"""Tests for ``Entity.assets_by_path`` — folder-prefix queries on ``asset_ref``.

Builds a tmp_path folder tree, seeds Entity rows directly with canonical
``asset_ref`` values pointing at those paths, and exercises positive and
negative ``types × search_dirs`` combinations.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.skill import Skill
from flow_sdk.core.entity.entity_model import Entity, PathQueryOptions
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.server.routes.assets import list_entities_by_path

# ---------- Fixture ----------------------------------------------------------

#   <tmp>/
#     skills/
#       skill_a/        Skill
#       skill_b/        Skill
#     agents/
#       agent_x.md      Agent
#     docs/
#       doc_y.md        Docs (markdown)
#       nested/
#         doc_z.md      Docs (markdown)


@pytest.fixture
async def asset_tree(tmp_path: Path) -> dict:
    """Materialize directories on disk and seed Entity rows with asset_ref."""
    skills_dir = tmp_path / "skills"
    agents_dir = tmp_path / "agents"
    docs_dir = tmp_path / "docs"
    nested_dir = docs_dir / "nested"
    for d in (skills_dir, agents_dir, docs_dir, nested_dir):
        d.mkdir(parents=True, exist_ok=True)

    skill_a_path = skills_dir / "skill_a"
    skill_b_path = skills_dir / "skill_b"
    skill_a_path.mkdir()
    skill_b_path.mkdir()
    agent_x_path = agents_dir / "agent_x.md"
    doc_y_path = docs_dir / "doc_y.md"
    doc_z_path = nested_dir / "doc_z.md"
    for f in (agent_x_path, doc_y_path, doc_z_path):
        f.write_text("# stub\n")

    # Use uuid suffix so re-runs against a persistent DB don't collide on uname.
    suffix = uuid.uuid4().hex[:8]

    skill_a = Skill(id=str(uuid.uuid4()), name=f"skill_a_{suffix}",
                    asset_ref=canonical_posix_path(skill_a_path))
    skill_b = Skill(id=str(uuid.uuid4()), name=f"skill_b_{suffix}",
                    asset_ref=canonical_posix_path(skill_b_path))
    agent_x = Agent(id=str(uuid.uuid4()), name=f"agent_x_{suffix}",
                    asset_ref=canonical_posix_path(agent_x_path))
    doc_y = Docs(id=str(uuid.uuid4()), name=f"doc_y_{suffix}",
                 asset_ref=canonical_posix_path(doc_y_path))
    doc_z = Docs(id=str(uuid.uuid4()), name=f"doc_z_{suffix}",
                 asset_ref=canonical_posix_path(doc_z_path))
    for e in (skill_a, skill_b, agent_x, doc_y, doc_z):
        await e.save()

    yield {
        "tmp": tmp_path,
        "skills_dir": skills_dir,
        "agents_dir": agents_dir,
        "docs_dir": docs_dir,
        "nested_dir": nested_dir,
        "skill_a": skill_a,
        "skill_b": skill_b,
        "agent_x": agent_x,
        "doc_y": doc_y,
        "doc_z": doc_z,
    }

    # Cleanup — remove the entities we created so other tests are unaffected.
    for e in (skill_a, skill_b, agent_x, doc_y, doc_z):
        try:
            await e.delete()
        except Exception:
            pass


def _ids(entities: list) -> set[str]:
    return {e.id for e in entities}


# ---------- Positive cases ---------------------------------------------------


@pytest.mark.asyncio
async def test_all_types_under_root(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["tmp"]],
    ))
    expected = {asset_tree[k].id for k in ("skill_a", "skill_b", "agent_x", "doc_y", "doc_z")}
    assert expected.issubset(_ids(res))


@pytest.mark.asyncio
async def test_path_rows_emit_remote_booleans(asset_tree: dict) -> None:
    asset_tree["skill_a"].remote = True
    await asset_tree["skill_a"].save()

    response = await list_entities_by_path(
        folder=[str(asset_tree["skills_dir"])],
        record_type=["skill"],
        include_system=False,
        limit=100,
        offset=0,
    )
    rows = json.loads(response.body)["data"]["entities"]
    by_id = {row["id"]: row for row in rows}

    assert by_id[asset_tree["skill_a"].id]["remote"] is True
    assert by_id[asset_tree["skill_b"].id]["remote"] is False


@pytest.mark.asyncio
async def test_skill_filter_under_root(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["tmp"]],
        types=["skill"],
    ))
    assert _ids(res) == {asset_tree["skill_a"].id, asset_tree["skill_b"].id}


@pytest.mark.asyncio
async def test_skill_or_agent_under_root(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["tmp"]],
        types=["skill", "agent"],
    ))
    assert _ids(res) == {
        asset_tree["skill_a"].id, asset_tree["skill_b"].id, asset_tree["agent_x"].id,
    }


@pytest.mark.asyncio
async def test_only_skills_dir(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["skills_dir"]],
    ))
    assert _ids(res) == {asset_tree["skill_a"].id, asset_tree["skill_b"].id}


@pytest.mark.asyncio
async def test_docs_recursive(asset_tree: dict) -> None:
    """Docs include the nested file because the range is recursive."""
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["docs_dir"]],
    ))
    assert _ids(res) == {asset_tree["doc_y"].id, asset_tree["doc_z"].id}


@pytest.mark.asyncio
async def test_union_two_dirs(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["skills_dir"], asset_tree["docs_dir"]],
    ))
    assert _ids(res) == {
        asset_tree["skill_a"].id, asset_tree["skill_b"].id,
        asset_tree["doc_y"].id, asset_tree["doc_z"].id,
    }


@pytest.mark.asyncio
async def test_union_two_dirs_with_type_filter(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["skills_dir"], asset_tree["docs_dir"]],
        types=["skill", "markdown"],
    ))
    assert _ids(res) == {
        asset_tree["skill_a"].id, asset_tree["skill_b"].id,
        asset_tree["doc_y"].id, asset_tree["doc_z"].id,
    }


@pytest.mark.asyncio
async def test_trailing_slash_tolerated(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[str(asset_tree["skills_dir"]) + "/"],
    ))
    assert _ids(res) == {asset_tree["skill_a"].id, asset_tree["skill_b"].id}


# ---------- Negative cases ---------------------------------------------------


@pytest.mark.asyncio
async def test_skill_in_agents_dir_returns_empty(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["agents_dir"]],
        types=["skill"],
    ))
    assert res == []


@pytest.mark.asyncio
async def test_markdown_in_skills_dir_returns_empty(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["skills_dir"]],
        types=["markdown"],
    ))
    assert res == []


@pytest.mark.asyncio
async def test_skill_or_agent_in_docs_returns_empty(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["docs_dir"]],
        types=["skill", "agent"],
    ))
    assert res == []


@pytest.mark.asyncio
async def test_no_search_dirs_returns_empty(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(search_dirs=[]))
    assert res == []


@pytest.mark.asyncio
async def test_nonexistent_dir_returns_empty(asset_tree: dict) -> None:
    res = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=[asset_tree["tmp"] / "does_not_exist"],
    ))
    assert res == []


# ---------- Edge cases -------------------------------------------------------


@pytest.mark.asyncio
async def test_dir_as_self_not_returned(asset_tree: dict) -> None:
    """Querying for descendants of skill_a's own folder must NOT return skill_a.

    The range is half-open ``[X/, X0)`` — `X` itself doesn't match.
    """
    skill_a_path = asset_tree["skills_dir"] / "skill_a"
    res = await Entity.assets_by_path(PathQueryOptions(search_dirs=[skill_a_path]))
    assert asset_tree["skill_a"].id not in _ids(res)
