"""Worker discovery must follow launch roots, not the all-harness indexer."""

from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.assets.asset_discovery import (
    AssetSearchRoot,
    discover_asset_paths,
    project_ancestors,
)
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.schema.types import EntityType


def skill(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: Fixture skill\n---\nInstructions.\n")
    return folder.resolve()


@pytest.mark.parametrize("pty_mode", [False, True], ids=["headless", "pty"])
@pytest.mark.parametrize("mode", ["vibe", "standard", "advanced", "dev"])
@pytest.mark.parametrize("worker,expected", [
    (WorkerType.CLAUDE_CODE, {".claude"}),
    (WorkerType.CODEX, {".agents"}),
    (WorkerType.COPILOT, {".github", ".agents", ".claude"}),
    (WorkerType.OPENCODE, {".opencode", ".agents", ".claude"}),
])
def test_project_skills_follow_worker_discovery(tmp_path, pty_mode, mode, worker, expected):
    candidates = {prefix: skill(tmp_path / prefix / "skills", "probe")
                  for prefix in (".claude", ".agents", ".github", ".opencode")}
    process = AgenticProcess(worker_type=worker, workdir=str(tmp_path), pty_mode=pty_mode, last_mode=mode,
                             load_flowpad_assistant=False)
    paths = discover_asset_paths(process.driver.asset_search_roots(process))[EntityType.SKILL]
    assert {prefix for prefix, path in candidates.items() if str(path) in paths} == expected


@pytest.mark.parametrize("worker,expected", [
    (WorkerType.CLAUDE_CODE, {".claude"}),
    (WorkerType.CODEX, set()),
    (WorkerType.COPILOT, {".github"}),
    (WorkerType.OPENCODE, {".claude", ".agents", ".github", ".opencode"}),
])
def test_mount_skills_follow_launch_projection(tmp_path, worker, expected):
    cwd = tmp_path / "work"
    cwd.mkdir()
    mount = tmp_path / "mount"
    candidates = {prefix: skill(mount / prefix / "skills", "probe")
                  for prefix in (".claude", ".agents", ".github", ".opencode")}
    process = AgenticProcess(worker_type=worker, workdir=str(cwd), additional_dirs=[str(mount)],
                             load_flowpad_assistant=False)
    paths = discover_asset_paths(process.driver.asset_search_roots(process))[EntityType.SKILL]
    assert {prefix for prefix, path in candidates.items() if str(path) in paths} == expected


def test_discovery_requires_carrier_and_handles_symlink_cycles(tmp_path):
    root = tmp_path / "skills"
    valid = skill(root, "valid")
    (root / "yaml-only").mkdir()
    (root / "yaml-only/skill.yaml").write_text("name: yaml-only\n")
    (root / "alias").symlink_to(valid, target_is_directory=True)
    (valid / "cycle").symlink_to(root, target_is_directory=True)
    paths = AssetSearchRoot(asset_type=EntityType.SKILL, path=root, recursive=True).asset_paths()
    assert paths == [valid]


def test_ancestor_discovery_stops_at_git_worktree(tmp_path):
    root = tmp_path / "repo"
    cwd = root / "packages" / "app"
    cwd.mkdir(parents=True)
    (root / ".git").write_text("gitdir: /some/worktree\n")
    assert project_ancestors(cwd) == [cwd, cwd.parent, root]
