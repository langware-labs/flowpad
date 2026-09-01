"""INSTALLED phase, project scope: installing an asset into a project must
stamp the entity with the CHOSEN scope, not only the project_id.

Per the reception phase model (docs/collab/messages-and-attachments.md §6):
"Phase 4 INSTALLED — the ONE install action: copy/clone + reindex with the
chosen scope/project stamped."

Bug: for project scope, ``index_attachments`` calls
``_reindex_received_assets``, which delegates to ``_reindex_root``, whose root
FSRef hardcodes ``scope="user"`` (flow_message_bundle.py:913) and only threads
``project_id``. So an install-in-project yields ``scope='user'`` +
``project_id=<project>`` — and project-scope views keep only scope in
{project, system}, so the asset stays invisible in the project it was
installed into.

No mocks: real Project + real task.md on disk + the real reception indexer.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Register TASK TypeInfo (main_layout=folder, main_file=task.md, extractor, owns).
import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TASK_ID = "6fcd0025-84e9-4c0b-a13d-8f3a4f295dd6"
INSTALLED_TASK_ID = "c41f77a2-9b0e-4d63-8a51-6e2c9d4f7b38"

_TASK_MD = "---\nid: {tid}\ntitle: ex7a\nstatus: to_do\ntask_type: Task\nkind: standard\n---\n"


async def _make_project(root: Path, name: str) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    pid = Project.derive_id_for_path(str(root))
    proj = Project(id=pid, name=name, fs_storage_mount_path=str(root))
    await proj.save()
    return proj


async def test_installed_task_asset_is_stamped_with_project(tmp_path: Path) -> None:
    """Control: a project-scope root FSRef DOES stamp both project_id and scope."""
    proj = await _make_project(tmp_path / "cyber6", "cyber6")

    task_dir = tmp_path / "cyber6" / "agentic-assets" / "task" / "ex7a"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.md").write_text(_TASK_MD.format(tid=TASK_ID), encoding="utf-8")

    indexer = build_default_indexer()
    await indexer.index(
        IndexerOptions(
            roots=(
                FSRef(
                    Path(proj.fs_storage_mount_path),
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=proj.id,
                ),
            ),
            types=(RecordType.TASK,),
            force=True,
            verbose=False,
        )
    )

    task_cls = SchemaRegistry.get_entity_cls("task")
    tasks = await task_cls.get_all({"id": TASK_ID})
    assert tasks, "index did not materialize the task row"
    task = tasks[0]

    assert task.project_id == proj.id, (
        f"installed task not associated with its project: got project_id={task.project_id!r}, expected {proj.id!r}"
    )
    assert task.scope == "project", f"installed task not project-scoped: got scope={task.scope!r}, expected 'project'"


async def test_install_in_project_stamps_project_scope(tmp_path: Path) -> None:
    """The REAL install path for project scope must stamp scope='project'."""
    from flow_sdk.builtin.flow_message_bundle import _reindex_received_assets

    proj = await _make_project(tmp_path / "cyber6b", "cyber6b")

    task_dir = tmp_path / "cyber6b" / "agentic-assets" / "task" / "ex7a-installed"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.md").write_text(_TASK_MD.format(tid=INSTALLED_TASK_ID), encoding="utf-8")

    # The exact call install makes for AttachmentScope.PROJECT
    # (index_attachments -> _reindex_received_assets).
    await _reindex_received_assets(Path(proj.fs_storage_mount_path), (RecordType.TASK,), project_id=proj.id)

    task_cls = SchemaRegistry.get_entity_cls("task")
    tasks = await task_cls.get_all({"id": INSTALLED_TASK_ID})
    assert tasks, "install reindex did not materialize the task row"
    task = tasks[0]

    assert task.project_id == proj.id, (
        f"installed task lost its project: got project_id={task.project_id!r}, expected {proj.id!r}"
    )
    assert task.scope == "project", (
        f"install-in-project did not stamp the chosen scope: got scope={task.scope!r}, "
        f"expected 'project' (project_id={task.project_id!r})"
    )
