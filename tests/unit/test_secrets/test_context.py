"""``await context.current_project()`` — the project of the working directory."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk import context

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_the_current_project_is_the_nearest_mount_above_the_working_directory(project, monkeypatch):
    nested = Path(project.fs_storage_mount_path) / "src" / "pkg"
    nested.mkdir(parents=True)
    monkeypatch.chdir(nested)

    found = await context.current_project()

    assert found is not None and found.id == project.id


async def test_outside_every_project_there_is_none(folder_db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert await context.current_project() is None


async def test_a_project_names_its_env_file_per_environment(project):
    mount = Path(project.fs_storage_mount_path)

    assert project.env_file_path() == mount / ".env.local"
    assert project.env_file_path("production") == mount / ".env.production.local"
    with pytest.raises(ValueError):
        project.env_file_path("Not An Env")
