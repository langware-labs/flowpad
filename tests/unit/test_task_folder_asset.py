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
from flow_sdk.fs_store.indexer.functions.task import extract_task, task_gen_id


@pytest.fixture(scope="module", autouse=True)
def _registered():
    register_all()


def _task_md_body_from(entity) -> str:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    return SchemaRegistry.get("task").default_body_fn(entity)


def test_default_body_stamps_id_and_omits_sender_local():
    from flow_sdk.builtin.task import Task

    t = Task(title="My Task", status="in_progress", priority="high")
    t.project_root = "/sender/only"
    t.my_process_id = "sender-proc"
    body = _task_md_body_from(t)

    assert f"id: {t.id}" in body
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
    # id is stable (adopted from frontmatter, not re-minted).
    assert task_gen_id(ref) == str(t.id)

    rec = extract_task(ref)[0]
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
    assert f"id: {task.id}" in task_md.read_text(encoding="utf-8")


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
    assert task_gen_id(ref) == "11111111-1111-4111-8111-111111111111"

    rec = extract_task(ref)[0]
    assert rec.id == "11111111-1111-4111-8111-111111111111"
    assert rec.name == "Legacy Task"
    # asset_ref → folder so the next save self-heals into task.md.
    assert rec.asset_ref._path == folder.resolve()
    # Sender-local keys are NOT adopted from the legacy manifest.
    assert not hasattr(rec, "my_process_id")
    assert not hasattr(rec, "project_root")
