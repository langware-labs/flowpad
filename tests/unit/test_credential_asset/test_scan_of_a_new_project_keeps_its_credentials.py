"""A project opened from git: the one-shot scan of its folder must file its credentials under it.

``create-project-from-git`` clones, creates the Project row, then scans the folder with
``_index_additional_dir`` — a root with ``scope="user"`` and no project (it is shared with context
folders). A workspace project lives under the user home, so without the walk associating each file
with the project that owns its folder, every credential the repo declares landed as the USER's:
``credentials_in_scope`` then filed them as user credentials, and the project's setup readiness
said "ready" while its MUST values were unset (seen live on a fresh container, 2026-09-29).

Real isolated DB, real Project row (v4 id) under the user home, the real scan entry point.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir
from flow_sdk.builtin.credential import Credential
from flow_sdk.builtin.project import Project
from flow_sdk.builtin import project_setup
from flow_sdk.fs_store.indexer import reset_shared_indexer
from flow_sdk.instance_settings import get_instance_settings

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _fresh_indexer(monkeypatch):
    reset_shared_indexer()

    async def none(_project):
        return []

    monkeypatch.setattr(project_setup, "project_sources", none)
    yield
    reset_shared_indexer()


async def test_a_cloned_projects_credentials_are_the_projects_and_count_toward_its_readiness(folder_db):
    root = Path(get_instance_settings().user_home) / "Flowpad workspace" / f"spora-{time.time_ns()}"
    folder = root / "agentic-assets" / "credential" / "google-cloud"
    folder.mkdir(parents=True)
    (folder / "credential.json").write_text(json.dumps({
        "schema": 2, "name": "google-cloud",
        "vars": {"GOOGLE_APPLICATION_CREDENTIALS": {"kind": "file", "required": "MUST"}},
    }))
    (folder / "setup.md").write_text("Create a key.")
    project = Project(name=root.name, fs_storage_mount_path=str(root))
    await project.save()

    await _index_additional_dir(str(root))  # what create-project-from-git runs after the clone

    row = await Credential.get("google-cloud", project)
    assert (row.scope, str(row.project_id)) == ("project", str(project.id))
    readiness = await project_setup.readiness_of(project)
    assert readiness.ready is False and [r.name for r in readiness.to_do] == ["google-cloud"]
