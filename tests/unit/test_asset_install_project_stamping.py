"""Installing a task asset into a project and indexing it must stamp the task
entity with that project's scope.

Repro of the observed bug: the "Install in project" flow copies a task onto
disk at ``<project>/agentic-assets/task/<name>/task.md`` (the recursive
repo-asset layout), then indexes. Observed in the live DB: the resulting
``task`` entity stays ``scope='user'`` with an empty ``project_id`` — so it is
absent from the project's scope and the conversation still shows the
"Select Project" pill.

No mocks: real test DB + a real Project row + the real ``build_default_indexer``
walk over a project root FSRef, then read the persisted task back.
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


async def _make_project(root: Path, name: str) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    pid = Project.derive_id_for_path(str(root))
    proj = Project(id=pid, name=name, fs_storage_mount_path=str(root))
    await proj.save()
    return proj


async def test_installed_task_asset_is_stamped_with_project(tmp_path: Path) -> None:
    # 1. A real folder project.
    proj = await _make_project(tmp_path / "cyber6", "cyber6")

    # 2. Copy the task asset into the project exactly where "Install in project"
    #    places it: <project>/agentic-assets/task/<name>/task.md.
    task_dir = tmp_path / "cyber6" / "agentic-assets" / "task" / "ex7a"
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.md").write_text(
        f"---\nid: {TASK_ID}\ntitle: ex7a\nstatus: to_do\ntask_type: Task\nkind: standard\n---\n\n# ex7a\n",
        encoding="utf-8",
    )

    # 3. Index the project root — the same project-scope root the indexer seeds
    #    for a real project mount (scope='project' + derived project_id).
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
    assert task_cls is not None, "task entity class not registered"
    # get_all (not get_one) — get_one eager-expands blob storage, which the
    # unit-DB fixture doesn't wire; we only need the persisted scalar fields.
    tasks = await task_cls.get_all({"id": TASK_ID})
    assert tasks, "index did not materialize the task row"
    task = tasks[0]

    # 4. THE RULE: a task copied into a project and indexed belongs to that
    #    project. Observed bug: it comes back scope='user', project_id=''.
    assert task.project_id == proj.id, (
        f"installed task not associated with its project: got project_id={task.project_id!r}, expected {proj.id!r}"
    )
    assert task.scope == "project", f"installed task not project-scoped: got scope={task.scope!r}, expected 'project'"


PREEXISTING_TASK_ID = "aaaa0025-84e9-4c0b-a13d-8f3a4f295dd6"

_TASK_MD = (
    f"---\nid: {PREEXISTING_TASK_ID}\ntitle: ex7a\nstatus: to_do\ntask_type: Task\nkind: standard\n---\n\n# ex7a\n"
)


async def test_reindex_restamps_preexisting_user_task(tmp_path: Path) -> None:
    """The realistic install flow: the task already exists as a USER-scope
    record (a received task), THEN the asset is copied into the project and
    re-indexed. The re-index must re-associate it with the project.
    """
    proj = await _make_project(tmp_path / "cyber6", "cyber6")

    # 1. Precondition: the task first exists at user scope (received task),
    #    indexed from a user-scope root — scope='user', project_id=''.
    user_dir = tmp_path / "userhome" / "agentic-assets" / "task" / "ex7a"
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "task.md").write_text(_TASK_MD, encoding="utf-8")

    indexer = build_default_indexer()
    await indexer.index(
        IndexerOptions(
            roots=(
                FSRef(
                    tmp_path / "userhome",
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="user",
                    project_id=None,
                ),
            ),
            types=(RecordType.TASK,),
            force=True,
            verbose=False,
        )
    )
    task_cls = SchemaRegistry.get_entity_cls("task")
    pre = (await task_cls.get_all({"id": PREEXISTING_TASK_ID}))[0]
    assert pre.scope == "user" and not pre.project_id, (
        f"precondition not set up: scope={pre.scope!r} project_id={pre.project_id!r}"
    )

    # 2. Now the asset is copied into the project and re-indexed over the
    #    project-scope root (the "Install in project" + index step).
    proj_dir = tmp_path / "cyber6" / "agentic-assets" / "task" / "ex7a"
    proj_dir.mkdir(parents=True, exist_ok=True)
    (proj_dir / "task.md").write_text(_TASK_MD, encoding="utf-8")

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

    task = (await task_cls.get_all({"id": PREEXISTING_TASK_ID}))[0]
    assert task.project_id == proj.id, (
        f"re-indexed task not associated with its project: got project_id={task.project_id!r}, expected {proj.id!r}"
    )
    assert task.scope == "project", f"re-indexed task not project-scoped: got scope={task.scope!r}, expected 'project'"
