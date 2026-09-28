"""Every place an asset can come from, built for real on disk, attributed to the
source the Assets board's scope toggles filter on.

One world: the user's home, the run's workdir, a folder added to the run (never
indexed — no DB row exists, the absence IS the condition), a project with a
context folder, the mounted Flowpad Assistant root, and a path the worker reported
from outside all of them. Each yields exactly one ``AssetSource``; the board maps
sources to toggles through ``tests/fixtures/asset_board_scopes.json``, which the
UI suite asserts from its side.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.asset import Asset
from flow_sdk.assets.catalog import AssetSource, descriptor_from_asset, scan_path_asset_descriptors
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.instance_settings import reset_instance_settings

CONTRACT = json.loads((Path(__file__).parents[1] / "fixtures" / "asset_board_scopes.json").read_text())


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "home"
    path.mkdir()
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(path))
    reset_instance_settings()
    yield path
    reset_instance_settings()


def skill(root: Path, name: str = "probe") -> Path:
    path = root / ".claude/skills" / name
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(f"---\nid: {mint_uuid()}\nname: {name}\ndescription: Probe\n---\nInstructions.")
    return path


def agent(root: Path, name: str = "persona") -> Path:
    path = root / ".claude/agents" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: Probe\n---\nYou are a test persona.")
    return path


def test_every_backend_source_has_a_board_scope():
    """A new AssetSource cannot reach the board without a toggle to live under."""
    assert set(CONTRACT["by_source"]) == {s.value for s in AssetSource}
    assert set(CONTRACT["by_source"].values()) <= set(CONTRACT["scopes"])
    assert set(CONTRACT["default_shown"]) == {"project", "dirs"}


@pytest.mark.asyncio
async def test_a_run_sees_user_workdir_and_added_folder_assets_straight_from_disk(home, tmp_path):
    user = skill(home)
    work = skill(tmp_path / "work")
    extra = tmp_path / "extra"  # never indexed
    extra_skill, extra_agent = skill(extra), agent(extra)

    run = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path / "work"), additional_dirs=[str(extra)], load_flowpad_assistant=False)
    rows = {row.posix_path: row for row in await run.get_asset_descriptors()}

    assert {path: row.source for path, row in rows.items()} == {
        str(user): AssetSource.USER_DIR,
        str(work): AssetSource.WORKDIR,
        str(extra_skill): AssetSource.ADDITIONAL_DIR,
        str(extra_agent): AssetSource.ADDITIONAL_DIR,
    }
    assert rows[str(extra_skill)].source_dir == rows[str(extra_agent)].source_dir == str(extra)
    assert rows[str(extra_skill)].typeid.startswith("skill-")
    assert rows[str(extra_agent)].typeid.startswith("subagent-")
    # Nothing verified by a worker yet: listed, not claimed available.
    assert all(not row.usage and not row.available for row in rows.values())


@pytest.mark.asyncio
async def test_a_project_and_its_context_folder_are_told_apart(tmp_path):
    own, context = skill(tmp_path / "project"), skill(tmp_path / "context")
    sources = [(str(tmp_path / "project"), AssetSource.PROJECT_DIR), (str(tmp_path / "context"), AssetSource.CONTEXT_DIR)]
    rows = {r.posix_path: r for r in (await scan_path_asset_descriptors(sources, "project-id", ["skill"])).assets}
    assert rows[str(own)].source == AssetSource.PROJECT_DIR and rows[str(own)].project_id == "project-id"
    assert rows[str(context)].source == AssetSource.CONTEXT_DIR and rows[str(context)].project_id is None


def test_worker_reported_paths_split_into_assistant_and_worker_extras(tmp_path):
    """The mounted assistant's assets and the worker's own extras reach the board
    only through what the worker reports; the path decides which toggle they're under."""
    assistant_root = tmp_path / "assistant"
    sources = [(str(tmp_path / "home"), AssetSource.USER_DIR), (str(assistant_root), AssetSource.SYSTEM)]
    mounted = descriptor_from_asset(Asset.from_path(skill(assistant_root, "decker")), sources)
    plugin = descriptor_from_asset(Asset.from_path(skill(tmp_path / "plugins/cache/acme", "lint")), sources)
    assert mounted.source == AssetSource.SYSTEM and CONTRACT["by_source"][mounted.source.value] == "assistant"
    assert plugin.source == AssetSource.EXTERNAL and CONTRACT["by_source"][plugin.source.value] == "worker"
