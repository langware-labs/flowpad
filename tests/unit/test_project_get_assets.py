"""Unit tests for ``Project.get_assets_action`` (project/{id}/get-assets).

The pre-process (staging) counterpart of the AgenticProcess asset view:
path-scan attribution over user-home / project-mount dirs plus a bounded
scoped list for ``spec`` (not file-backed). Fixture style mirrors
``tests/unit/test_agentic_process_get_assets.py``.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.agentic_process import AssetSource
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.subagent import SubAgent
from flow_sdk.fs_store.path_utils import canonical_posix_path

# ── Fixture ───────────────────────────────────────────────────────────────────


@pytest.fixture
async def staging(tmp_path: Path, monkeypatch):
    """Project + entities across the staging source matrix.

    Layout::
      <tmp>/user_home/.claude/skills/u_skill/SKILL.md      (USER_DIR skill)
      <tmp>/user_home/docs/note.md                          (USER_DIR markdown)
      <tmp>/user_home/other_project/.claude/agents/o.md     (other-project agent — excluded)
      <tmp>/project/.claude/skills/p_skill/SKILL.md         (PROJECT_DIR skill)
    """
    user_home = tmp_path / "user_home"
    project_root = tmp_path / "project"

    paths = {
        "u_skill": user_home / ".claude" / "skills" / "u_skill",
        "doc_note": user_home / "docs" / "note.md",
        "other_agent": user_home / "other_project" / ".claude" / "agents" / "o.md",
        "p_skill": project_root / ".claude" / "skills" / "p_skill",
    }
    for p in paths.values():
        if p.suffix == ".md":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("# stub\n")
        else:
            p.mkdir(parents=True, exist_ok=True)

    from flow_sdk.instance_settings import reset_instance_settings

    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    reset_instance_settings()

    suffix = uuid.uuid4().hex[:6]

    async def _save(e):
        await e.save()
        return e

    project = await _save(
        Project(
            id=mint_uuid(),
            name=f"staging_project_{suffix}",
            fs_storage_mount_path=str(project_root),
        )
    )
    other_project_id = mint_uuid()

    ents = {
        "u_skill": await _save(
            Skill(
                id=mint_uuid(),
                name=f"u_skill_{suffix}",
                asset_ref=canonical_posix_path(paths["u_skill"]),
            )
        ),
        "doc_note": await _save(
            Docs(
                id=mint_uuid(),
                name=f"doc_note_{suffix}",
                asset_ref=canonical_posix_path(paths["doc_note"]),
            )
        ),
        # Project-scoped entity of ANOTHER project under the home catchall —
        # must be excluded by the _source_match_for_asset ownership rule.
        "other_agent": await _save(
            SubAgent(
                id=mint_uuid(),
                name=f"other_agent_{suffix}",
                asset_ref=canonical_posix_path(paths["other_agent"]),
                scope="project",
                project_id=other_project_id,
            )
        ),
        "p_skill": await _save(
            Skill(
                id=mint_uuid(),
                name=f"p_skill_{suffix}",
                asset_ref=canonical_posix_path(paths["p_skill"]),
                project_id=str(project.id),
            )
        ),
        "spec_project": await _save(
            Spec(
                id=mint_uuid(),
                title=f"spec_project_{suffix}",
                project_id=str(project.id),
            )
        ),
        "spec_user": await _save(
            Spec(
                id=mint_uuid(),
                title=f"spec_user_{suffix}",
            )
        ),
    }

    yield {"project": project, "ents": ents, "user_home": user_home, "project_root": project_root}

    for e in [project, *ents.values()]:
        try:
            await e.delete()
        except Exception:
            pass
    reset_instance_settings()


def _rows(resp) -> list[dict]:
    return resp.data["assets"]


def _row_for(resp, entity) -> dict | None:
    return next((r for r in _rows(resp) if r["typeid"].endswith(entity.id)), None)


# ── Cases ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_source_attribution(staging):
    resp = await staging["project"].get_assets_action()

    u_skill = _row_for(resp, staging["ents"]["u_skill"])
    assert u_skill and u_skill["source"] == AssetSource.USER_DIR.value

    doc = _row_for(resp, staging["ents"]["doc_note"])
    assert doc and doc["source"] == AssetSource.USER_DIR.value

    p_skill = _row_for(resp, staging["ents"]["p_skill"])
    assert p_skill and p_skill["source"] == AssetSource.PROJECT_DIR.value
    assert p_skill["project_id"] == str(staging["project"].id)


@pytest.mark.asyncio
async def test_other_project_entity_excluded(staging):
    resp = await staging["project"].get_assets_action()
    assert _row_for(resp, staging["ents"]["other_agent"]) is None


@pytest.mark.asyncio
async def test_spec_rows(staging):
    resp = await staging["project"].get_assets_action()

    spec_project = _row_for(resp, staging["ents"]["spec_project"])
    assert spec_project is not None
    assert spec_project["posix_path"] is None
    assert spec_project["source"] == AssetSource.PROJECT_DIR.value
    assert spec_project["project_id"] == str(staging["project"].id)

    spec_user = _row_for(resp, staging["ents"]["spec_user"])
    assert spec_user is not None
    assert spec_user["source"] == AssetSource.USER_DIR.value
    assert spec_user["project_id"] is None


@pytest.mark.asyncio
async def test_types_param_filters(staging):
    resp = await staging["project"].get_assets_action(types="skill")
    typeids = {r["typeid"].split("-", 1)[0] for r in _rows(resp)}
    assert typeids <= {"skill"}
    assert _row_for(resp, staging["ents"]["u_skill"]) is not None
    assert _row_for(resp, staging["ents"]["doc_note"]) is None
    assert _row_for(resp, staging["ents"]["spec_project"]) is None


@pytest.mark.asyncio
async def test_limit_and_truncated(staging):
    resp = await staging["project"].get_assets_action(limit=1)
    assert len(_rows(resp)) == 1
    assert resp.data["truncated"] is True

    resp_full = await staging["project"].get_assets_action()
    assert resp_full.data["truncated"] is False


@pytest.mark.asyncio
async def test_response_row_shape_matches_process_action(staging):
    resp = await staging["project"].get_assets_action()
    rows = _rows(resp)
    assert rows, "expected at least one descriptor"
    # Process action keys + additive project_id; usage always present.
    for row in rows:
        assert set(row.keys()) == {
            "typeid",
            "source",
            "posix_path",
            "source_dir",
            "project_id",
            "remote",
            "usage",
        }
        assert row["usage"] == []


@pytest.mark.asyncio
async def test_ref_only_remote_hydration_batches_once_per_type(staging):
    from flow_sdk.builtin.agentic_process.agentic_process import AssetDescriptor

    skill = staging["ents"]["u_skill"]
    agent = staging["ents"]["other_agent"]
    skill.remote = True
    await skill.save()
    descriptors = [
        AssetDescriptor(
            typeid=f"skill-{skill.id}",
            source=AssetSource.USER_DIR,
            posix_path=None,
        ),
        AssetDescriptor(
            typeid=f"subagent-{agent.id}",
            source=AssetSource.USER_DIR,
            posix_path=None,
        ),
    ]

    with (
        patch(
            "flow_sdk.builtin.agentic_process.agentic_process.scan_path_asset_descriptors",
            new=AsyncMock(return_value=descriptors),
        ),
        patch.object(Skill, "get_all", new=AsyncMock(wraps=Skill.get_all)) as skill_get_all,
        patch.object(SubAgent, "get_all", new=AsyncMock(wraps=SubAgent.get_all)) as agent_get_all,
        patch.object(
            Skill,
            "get_one",
            new=AsyncMock(side_effect=AssertionError("get_one is not allowed")),
        ),
        patch.object(
            SubAgent,
            "get_one",
            new=AsyncMock(side_effect=AssertionError("get_one is not allowed")),
        ),
    ):
        response = await staging["project"].get_assets_action(types="skill,subagent")

    assert skill_get_all.await_count == 1
    assert agent_get_all.await_count == 1
    by_typeid = {row["typeid"]: row for row in response.data["assets"]}
    assert by_typeid[f"skill-{skill.id}"]["remote"] is True
    assert by_typeid[f"subagent-{agent.id}"]["remote"] is False
