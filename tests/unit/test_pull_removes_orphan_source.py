"""A git pull that deletes a data source's folder must take the source's row with it.

Ami's GTM Studio: a pull removed ``agentic-assets/data_source/gmail``; the row stayed, still
carrying the project's id, so the project's setup kept asking for a Gmail sign-in nobody could
give. Real git (origin, clone, push, pull), a real project and source, and the same refresh the
pull handler runs (``Project.find_by_cwd(...).refresh_pulled_assets()``, ``git_repo.py``).

# do not increase timeout without approval
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                   capture_output=True)


@pytest.fixture(autouse=True)
def _workspace(tmp_path, monkeypatch):
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)


@pytest.mark.asyncio
async def test_a_pull_that_deletes_a_sources_folder_removes_its_row(tmp_path):
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest.reflect import ReflectMode

    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", "-b", "main", str(origin))
    work = tmp_path / "gtm-studio"
    _git(tmp_path, "clone", str(origin), str(work))

    project = Project(name=unique_project_name("gtm-studio"), fs_storage_mount_path=str(work))
    await project.save()
    tree = tmp_path / "mail"
    tree.mkdir()
    (tree / "notes.md").write_text("# notes\n", encoding="utf-8")
    driver = await DataDriver.get("folder")
    src = driver.create_source(driver.create_config(root=str(tree)), name="gmail",
                               reflect=ReflectMode.NONE.value, project_id=str(project.id))
    await src.save()
    folder = Path(src.asset_ref)
    assert folder.is_dir() and folder.is_relative_to(work.resolve()), "the source is a folder in the project"

    _git(work, "add", "-A")
    _git(work, "commit", "-m", "gmail source")
    _git(work, "push", "origin", "HEAD:main")

    # A teammate deletes the source and pushes; this checkout pulls.
    other = tmp_path / "teammate"
    _git(tmp_path, "clone", str(origin), str(other))
    _git(other, "rm", "-r", "-q", str(folder.relative_to(work.resolve())))
    _git(other, "commit", "-m", "drop gmail source")
    _git(other, "push", "origin", "HEAD:main")
    _git(work, "pull", "-q", "origin", "main")
    assert not folder.exists(), "the pull removed the source's folder"

    pulled = await Project.find_by_cwd(str(work))
    assert pulled is not None and str(pulled.id) == str(project.id)
    await pulled.refresh_pulled_assets()

    assert await DataSource.get_one({"id": str(src.id)}) is None, (
        "the pull deleted the source's folder but its row stayed: an orphan the project still counts as its own"
    )
