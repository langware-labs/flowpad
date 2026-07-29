"""Task-as-folder-asset: default body whitelist + indexer round-trip.

Task converged onto the generic folder-asset rails (like ``skill``): ``task.md``
frontmatter is the shippable whitelist (sender-local fields excluded), the
indexer emits one record per ``tasks/<name>/`` folder and round-trips the id, and
legacy ``header.json`` folders are still readable without leaking sender-local
fields.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.task import extract_task
from flow_sdk.fs_store.schema_registry import SchemaRegistry


@pytest.fixture(scope="module", autouse=True)
def _registered():
    register_all()


def _task_md_body_from(entity) -> str:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    return SchemaRegistry.get("task").default_body_fn(entity)


def test_default_body_omits_identity_and_sender_local():
    from flow_sdk.builtin.task import Task

    t = Task(title="My Task", status="in_progress", priority="high")
    t.project_root = "/sender/only"
    t.my_process_id = "sender-proc"
    body = _task_md_body_from(t)

    assert f"id: {t.id}" not in body
    assert "My Task" in body and "in_progress" in body and "high" in body
    # Sender-local keys never written.
    for leak in ("project_root", "/sender/only", "my_process_id", "sender-proc", "project_id"):
        assert leak not in body


def test_indexer_round_trips_task_md(tmp_path):
    from flow_sdk.builtin.task import Task

    t = Task(title="Ship It", status="in_progress", priority="high", spec_type="plan",
             description="do the thing")
    folder = tmp_path / "tasks" / "ship-it"
    folder.mkdir(parents=True)
    (folder / "task.md").write_text(_task_md_body_from(t), encoding="utf-8")
    (folder / "spec.md").write_text("# Plan\n\nstep 1", encoding="utf-8")

    ref = FSRef(folder)
    # New identity is stored beside the folder, not in task.md frontmatter.
    assert SchemaRegistry.get("task").mint_id(ref, proposed_id=str(t.id)) == str(t.id)

    rec = extract_task(ref, str(t.id))[0]
    assert rec.id == str(t.id)
    assert rec.name == "Ship It"
    assert rec.status == "in_progress"
    assert getattr(rec, "priority", None) == "high"
    assert getattr(rec, "spec_type", None) == "plan"
    assert getattr(rec, "description", None) == "do the thing"
    # asset_ref points at the FOLDER (folder-backed), not the inner file.
    assert rec.asset_ref is not None
    assert rec.asset_ref._path == folder.resolve()


def test_orphan_task_self_heals_on_save(tmp_path):
    """A task with NO asset_ref (old DB-only row, pre-folder-asset) re-materializes
    its folder + task.md on save — the exact compute_asset_ref → upsert_main_ref
    path a save runs, and what the editor's "Rebuild file" action triggers."""
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.builtin.task import Task

    task = Task(title="Orphan Heal", status="to_do")
    assert task.asset_ref is None  # the orphan state
    rec = FSRecord(type="task", id=str(task.id))
    assert rec._asset_ref is None

    # 1) compute the folder asset_ref (owns_main_ref type → main_subdir set)
    ar = rec.compute_asset_ref(scope_root=tmp_path, entity=task)
    assert ar is not None, "task must resolve a folder asset_ref"
    rec._asset_ref = ar

    # 2) materialize the backing file from the default body
    rec.upsert_main_ref(task)
    task_md = ar._path / "task.md"
    assert task_md.is_file(), "save must write task.md into the freshly-created folder"
    assert f"id: {task.id}" not in task_md.read_text(encoding="utf-8")
    from flow_sdk.capsules import AssetCapsule

    assert AssetCapsule.from_path(ar._path).read("identity").data["id"] == str(task.id)


def test_indexer_tolerates_legacy_header_json_without_leak(tmp_path):
    folder = tmp_path / "tasks" / "legacy"
    folder.mkdir(parents=True)
    (folder / "header.json").write_text(
        json.dumps({
            "task_id": "11111111-1111-4111-8111-111111111111",
            "title": "Legacy Task",
            "status": "to_do",
            "priority": "low",
            "my_process_id": "SENDER-LEAK",
            "project_root": "/sender/path",
        }),
        encoding="utf-8",
    )
    ref = FSRef(folder)
    # Legacy id formula preserved.
    assert SchemaRegistry.get("task").mint_id(ref) == "11111111-1111-4111-8111-111111111111"

    rec = extract_task(ref, "11111111-1111-4111-8111-111111111111")[0]
    assert rec.id == "11111111-1111-4111-8111-111111111111"
    assert rec.name == "Legacy Task"
    # asset_ref → folder so the next save self-heals into task.md.
    assert rec.asset_ref._path == folder.resolve()
    # Sender-local keys are NOT adopted from the legacy manifest.
    assert not hasattr(rec, "my_process_id")
    assert not hasattr(rec, "project_root")


def test_archived_task_stays_archived_across_reindex(tmp_path):
    """``archived_at`` must survive BOTH reader paths.

    Regression: it was in neither ``TASK_FRONTMATTER_FIELDS`` nor the legacy
    manifest key list, so every reindex silently resurrected archived tasks as
    active ``to_do`` rows — an archived task the user never sees again reappears
    in the task list, once per historical folder.
    """
    from datetime import datetime, timezone

    from pydantic import TypeAdapter

    from flow_sdk.builtin.task import Task

    # The two readers surface the raw carrier value (YAML gives a str, JSON a
    # str, YAML-typed timestamps a datetime) — normalize before comparing.
    as_dt = TypeAdapter(datetime).validate_python
    archived = datetime(2026, 4, 26, 12, 30, 10, tzinfo=timezone.utc)

    # Modern path: entity -> task.md -> indexer.
    t = Task(title="Archived Task", status="to_do", archived_at=archived)
    folder = tmp_path / "tasks" / "archived-task"
    folder.mkdir(parents=True)
    (folder / "task.md").write_text(_task_md_body_from(t), encoding="utf-8")
    rec = extract_task(FSRef(folder), str(t.id))[0]
    assert as_dt(rec.archived_at) == archived

    # Legacy path: manifest.json -> indexer.
    legacy = tmp_path / "tasks" / "archived-legacy"
    legacy.mkdir(parents=True)
    (legacy / "manifest.json").write_text(
        json.dumps({
            "data": {
                "id": "22222222-2222-4222-8222-222222222222",
                "title": "Archived Legacy",
                "status": "to_do",
                "archived_at": archived.isoformat(),
            }
        }),
        encoding="utf-8",
    )
    rec2 = extract_task(FSRef(legacy), "22222222-2222-4222-8222-222222222222")[0]
    assert as_dt(rec2.archived_at) == archived

    # A never-archived task must not gain a spurious key.
    assert "archived_at" not in _task_md_body_from(Task(title="Live", status="to_do"))


# Task fields that deliberately do NOT survive the task.md round-trip: derived
# or sender-local (a received task must map its own local project), or local-only
# view state. ``group_name``/``reporter`` are NOT deliberate — they are written
# by group_task_action but dropped on reindex, the same drift that hid
# ``archived_at``. They are listed so this guard passes today; fixing them means
# moving them into TASK_FRONTMATTER_FIELDS, not extending this set.
_NOT_ROUND_TRIPPED = {
    "asset_ref", "my_process_id", "project_name", "project_root",   # derived / sender-local
    "last_viewed_at", "ttl", "target_entity", "workspace_id",       # local-only state
    "group_name", "reporter",                                       # KNOWN DRIFT — see above
}


def test_task_frontmatter_fields_covers_every_task_field():
    """Adding a Task field must be a deliberate round-trip choice, not silent drift.

    ``TASK_FRONTMATTER_FIELDS`` is hand-maintained, so a new field is dropped on
    reindex unless someone remembers to list it — exactly how ``archived_at``
    resurrected archived tasks. This fails loudly until the new field is either
    round-tripped or explicitly declared local.
    """
    from flow_sdk.builtin.task import Task
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.indexer.functions.task import TASK_FRONTMATTER_FIELDS

    # Only fields Task itself declares; base-Entity infrastructure (uname, scope,
    # created_by, …) is never frontmatter.
    own = set(Task.model_fields) - set(Entity.model_fields)
    explicit = {"title", "status", "description"}  # handled by name in both readers
    dropped = own - set(TASK_FRONTMATTER_FIELDS) - explicit

    assert dropped == _NOT_ROUND_TRIPPED, (
        "Task fields changed their round-trip status. Newly dropped: "
        f"{sorted(dropped - _NOT_ROUND_TRIPPED)}; newly covered: "
        f"{sorted(_NOT_ROUND_TRIPPED - dropped)}. Add the field to "
        "TASK_FRONTMATTER_FIELDS so it survives reindex, or to _NOT_ROUND_TRIPPED "
        "if it is genuinely local."
    )
