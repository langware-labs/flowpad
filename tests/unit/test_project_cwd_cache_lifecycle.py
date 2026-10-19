"""The indexer's cwd -> project id memo follows the project lifecycle.

``resolve_project_id_for_cwd`` memoises confirmed real-id hits so the per-record
stamp does not rescan the project table. That memo is a second copy of "which
project owns this folder" next to ``all_projects._PROJECTS_CACHE``, and it used
to have no lifecycle of its own: keyed by the RAW cwd (a trailing slash was a
second entry) and never cleared on delete, so it only grew and kept stamping a
deleted project's id on new records. Both proven on a live instance with 200
real projects; both enter here through the real resolver and the real delete.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.indexer import roots
from flow_sdk.fs_store.path_utils import canonical_posix_path

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _resolver_reads_the_test_db(monkeypatch: pytest.MonkeyPatch):
    """The resolver is sync and opens the sqlite file ``db_path`` names; point it
    at the session's test database so it sees the rows the entities write.
    (Not ``override_db_path``: that drops the cached async driver too, and the
    rest of the session would rebuild one against the real instance.)"""
    from dataclasses import replace

    import flow_sdk.instance_settings as instance_settings
    from tests import pytest_plugin

    settings = replace(instance_settings.get_instance_settings(), db_path=Path(pytest_plugin._test_db_driver.config.database))
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: settings)
    roots._CWD_PID_CACHE.clear()
    yield
    roots._CWD_PID_CACHE.clear()


async def _project_on(root: Path) -> Project:
    root.mkdir()
    proj = Project(name=root.name, fs_storage_mount_path=str(root))
    await proj.save()
    return proj


async def test_one_folder_is_one_entry_however_the_cwd_is_spelled(tmp_path: Path) -> None:
    proj = await _project_on(tmp_path / "spelled-proj")
    cwd = str(tmp_path / "spelled-proj")

    assert roots.resolve_project_id_for_cwd(cwd) == proj.id
    assert roots.resolve_project_id_for_cwd(cwd + "/") == proj.id

    assert list(roots._CWD_PID_CACHE) == [canonical_posix_path(cwd)]


async def test_deleting_a_project_forgets_its_folder(tmp_path: Path) -> None:
    proj = await _project_on(tmp_path / "deleted-proj")
    cwd = str(tmp_path / "deleted-proj")
    assert roots.resolve_project_id_for_cwd(cwd) == proj.id

    await Project.delete_by_id(str(proj.id))

    assert roots._CWD_PID_CACHE == {}, "the delete hook did not reach the cwd memo"
    assert roots.resolve_project_id_for_cwd(cwd) == Project.derive_id_for_path(cwd), (
        "a deleted project's id is still stamped on new records"
    )
