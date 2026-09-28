"""Re-indexing a declared project credential must leave it the project's.

`flow credentials declare` writes the folder and a row labelled
``scope=project, project_id=<Project.id>``. Every later index of that folder —
the app's own scans, `flow record index` on the project or on the credential —
rebuilds the row from the walker's record. Two paths re-derived the owner from
the PATH instead of the Project row, and the credential then dropped out of
`credentials_in_scope` (`flow credentials check` → ``declared: false``, the
editor → "This credential no longer exists"):

* indexing a DIRECTORY walks it with a root stamped
  ``Project.derive_id_for_path(dir)`` — the legacy uuid5, not the project's id;
* indexing the credential's OWN folder (``index_one``) labels it by
  ``classify_path``, which calls anything under the user home ``user``.

Real Project row with a real (v4) id under the user home — the
``~/Flowpad workspaces/<name>`` shape — a real declare, and the real
``/fs-records/index`` handler. The earlier index-handler tests could not see
the first path because they minted the Project with the very uuid5 the walk
stamps.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import pytest

from flow_sdk.builtin.credential import Credential
from flow_sdk.builtin.credential_service import declare_credential
from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.indexer import reset_shared_indexer
from flow_sdk.instance_settings import get_instance_settings

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MANIFEST = {
    "schema": 2,
    "name": "sentry",
    "title": "Sentry",
    "vars": {"SENTRY_DSN": {"label": "DSN", "required": False}},
    "setup": "Sentry → Settings → Projects → Client Keys (DSN).",
}


class _Params:
    def __init__(self, params: dict):
        self._p = params

    def get(self, key, default=None):
        return self._p.get(key, default)


class _RequestInfo:
    def __init__(self, params: dict):
        self.request = type("R", (), {"query_params": _Params(params)})()


class _Handler(FsRecordsActionsMixin):
    """The compute node's fs-records mixin, as the route mounts it."""

    def __init__(self):
        self.typeid = "test-compute-node"

    def _start_activity(self, job_name: str, timeout_seconds: int = 600):
        return InProcessActivity(job_name=job_name, entity_id=self.typeid, timeout_seconds=timeout_seconds)

    def _complete_activity(self, job_name: str) -> None:
        pass


@pytest.fixture(autouse=True)
def _fresh_indexer(monkeypatch):
    reset_shared_indexer()

    async def _no_broadcast(to_entity: str, flow_data: Any) -> None:
        return None

    monkeypatch.setattr("flow_sdk.core.network.resource_tracker.broadcast_progress", _no_broadcast)
    yield
    reset_shared_indexer()


@pytest.fixture
async def declared(folder_db):
    """A workspace project under the user home, with one declared credential."""
    root = Path(get_instance_settings().user_home) / "Flowpad workspaces" / f"cred-{time.time_ns()}" / "shop"
    root.mkdir(parents=True)
    project = Project(name="shop", fs_storage_mount_path=str(root))
    await project.save()
    assert project.id != Project.derive_id_for_path(str(root)), "the project must carry its own id, not the path hash"

    await declare_credential(MANIFEST, project_id=str(project.id))
    folder = root / "agentic-assets" / "credential" / "sentry"
    assert (folder / "credential.json").is_file()
    return project, folder


def _edited(folder: Path) -> None:
    """The folder changed on disk since it was indexed — the next index re-parses it."""
    later = time.time() + 5
    for f in folder.iterdir():
        os.utime(f, (later, later))


async def _index(path: Path) -> None:
    resp = await _Handler()._handle_fs_records_index(_RequestInfo({"type": "credential", "path": str(path)}))
    data = resp.data
    # A folder named directly is indexed in place (``total_*``); a directory is walked (``indexed``/``errors``).
    errors, indexed = data.get("total_errors", data.get("errors")), data.get("total_indexed", data.get("indexed"))
    assert errors == 0, data
    assert indexed and indexed >= 1, f"nothing was re-indexed at {path}: {data}"


async def _assert_still_the_projects(project: Project) -> None:
    row = await Credential.get("sentry", project)  # what `flow credentials check` resolves through
    assert (row.scope, str(row.project_id)) == ("project", str(project.id))


async def test_indexing_the_project_keeps_the_credential_the_projects(declared):
    project, folder = declared
    _edited(folder)
    await _index(Path(project.fs_storage_mount_path))
    await _assert_still_the_projects(project)


async def test_indexing_the_credential_folder_keeps_it_the_projects(declared):
    project, folder = declared
    _edited(folder)
    await _index(folder)
    await _assert_still_the_projects(project)
