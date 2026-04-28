"""Tests for Project.recover_by_path and AgenticProcess.recover_project_action.

Recovery walks 3 phases for a given workdir:
  1. Exact-match an existing Project by fs_storage_mount_path.
  2. Materialize from ~/.claude/projects/<encoded>/ via ClaudeProjectFsRecord.
  3. Construct a fresh Project from the path (deterministic uuid5 id).

These tests exercise the real DB + record bridge; phase 2 is verified via
``ClaudeProjectFsRecord._claude_projects_dir`` monkeypatched to a tmp dir.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


# ---------------------------------------------------------------------------
# Project.recover_by_path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recover_by_path_returns_none_for_empty(bootstrapped_client):
    """Empty path → None (nothing to recover)."""
    assert await Project.recover_by_path("") is None


@pytest.mark.asyncio
async def test_recover_by_path_phase1_exact_existing_match(bootstrapped_client, tmp_path):
    """Phase 1: an existing Project at the exact path is returned as-is."""
    target = tmp_path / "phase1-project"
    target.mkdir()
    proj = Project(name=str(target), fs_storage_mount_path=str(target))
    proj.id = Project.allocate_id(proj.model_dump())
    await proj.save()

    recovered = await Project.recover_by_path(str(target))
    assert recovered is not None
    assert recovered.id == proj.id
    assert recovered.fs_storage_mount_path == str(target)


@pytest.mark.asyncio
async def test_recover_by_path_phase2_materializes_claude_folder(
    bootstrapped_client, tmp_path, monkeypatch
):
    """Phase 2: when ~/.claude/projects/<encoded>/ exists, Project is materialized
    from the ClaudeProjectFsRecord and ends up queryable via the API."""
    real_path = tmp_path / "Users" / "x" / "Phase2Project"
    real_path.mkdir(parents=True)
    encoded = str(real_path).replace("/", "-")  # mirrors Claude's encoding

    fake_claude_projects_dir = tmp_path / "claude_projects"
    fake_claude_projects_dir.mkdir()
    claude_project_dir = fake_claude_projects_dir / encoded
    claude_project_dir.mkdir()
    # Stub session JSONL so _is_valid_project_dir doesn't reject it
    (claude_project_dir / "session.jsonl").write_text(
        '{"type":"user","cwd":"' + str(real_path) + '"}\n'
    )

    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_project._claude_projects_dir",
        lambda: fake_claude_projects_dir,
    )

    recovered = await Project.recover_by_path(str(real_path))
    assert recovered is not None
    # The materialized Project entity uses the path-based deterministic id
    # (Project.allocate_id), even though the underlying ClaudeProjectFsRecord
    # carries the encoded-name id.
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{real_path}"))
    assert recovered.id == expected_id
    assert recovered.fs_storage_mount_path == str(real_path)

    # And a follow-up lookup must hit phase 1 now (existing exact match).
    again = await Project.recover_by_path(str(real_path))
    assert again is not None
    assert again.id == expected_id


@pytest.mark.asyncio
async def test_recover_by_path_phase3_constructs_fresh_project(bootstrapped_client, tmp_path):
    """Phase 3: no existing Project, no Claude folder → fresh Project entity created."""
    # Use an absolute path that no project owns; isolate from any pre-seeded data.
    fresh = str(tmp_path / "phase3-fresh-only")
    recovered = await Project.recover_by_path(fresh)
    assert recovered is not None
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{fresh}"))
    assert recovered.id == expected_id
    assert recovered.fs_storage_mount_path == fresh


# ---------------------------------------------------------------------------
# AgenticProcess.recover_project_action
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recover_project_action_repoints_and_returns_entity():
    """Happy path: action calls recover_by_path, repoints project_id, saves, returns entity."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir="/Users/x/foo")

    fake_project = MagicMock()
    fake_project.id = "recovered-project-id"
    fake_project.model_dump = MagicMock(return_value={"id": "recovered-project-id", "type": "project"})

    with patch.object(Project, "recover_by_path", new=AsyncMock(return_value=fake_project)) as mock_recover, \
         patch.object(AgenticProcess, "save", new=AsyncMock()) as mock_save:
        result = await proc.recover_project_action()

    mock_recover.assert_awaited_once_with("/Users/x/foo")
    mock_save.assert_awaited_once()
    assert proc.project_id == "recovered-project-id"
    assert isinstance(result, ApiSuccessResponse)
    assert result.data == {"project": {"id": "recovered-project-id", "type": "project"}}


@pytest.mark.asyncio
async def test_recover_project_action_fails_when_no_workdir():
    """Without workdir, recovery cannot proceed → ApiFailResponse."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir=None)
    result = await proc.recover_project_action()
    assert isinstance(result, ApiFailResponse)
    assert "no workdir" in result.message.lower()


@pytest.mark.asyncio
async def test_recover_project_action_fails_when_recovery_returns_none():
    """If recover_by_path returns None, action fails (not a 200)."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir="/any/path")

    with patch.object(Project, "recover_by_path", new=AsyncMock(return_value=None)):
        result = await proc.recover_project_action()

    assert isinstance(result, ApiFailResponse)
    assert "/any/path" in result.message


# Silence unused warning when pytest fixture parameter is named-only.
_ = Path
