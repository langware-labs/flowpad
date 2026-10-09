"""A task's history: a LOCAL change of status or assignee is one comment on the task (``task_changes``).

The row keeps no history and its writer stamp never leaves this machine, so the comment is the record
both people read — written once per change, never for a hub echo of the other side's change, a
delegated task (the ledger logs those), a disk re-index, or the task's creation.
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin import task_changes
from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.task import Task
from flow_sdk.core.entity.entity_model import remote_reflection, suppress_store

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ME = "alice@example.test"
BOB = "bob@example.test"


@pytest.fixture(autouse=True)
def blob_storage(tmp_path, monkeypatch):
    """A Comment's body is a blob: a storage fallback outside a service context. And who "I" am."""
    import flow_sdk.cli.app_config as app_config  # noqa: PLC0415
    from flow_sdk.config import default_service_config  # noqa: PLC0415
    from flow_sdk.request_context import methods as _ctx  # noqa: PLC0415
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver  # noqa: PLC0415

    monkeypatch.setattr(app_config, "get_user", lambda: {"email": ME})
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev


async def _task(**fields) -> Task:
    return await Task(placement="instance", **{"title": f"t {mint_uuid()[:8]}", "assignee": ME, "reporter": ME, **fields}).save()


async def _history(task: Task) -> list[dict]:
    rows = await Comment.get_all({"parent_type_id": str(task.typeid)})
    return [dict(c.data or {}) for c in sorted(rows, key=lambda c: str(c.created_date or ""))]


async def test_creating_a_task_writes_no_history():
    task = await _task(status="in_progress")
    assert await _history(task) == []


async def test_each_change_is_one_comment_credited_to_me():
    task = await _task()
    task.status = "in_progress"
    await task.save()
    task.status = "done"
    task.assignee = BOB
    await task.save()

    history = await _history(task)
    assert [(h["change"], h["from"], h["to"]) for h in history] == [
        ("status", "to_do", "in_progress"), ("status", "in_progress", "done"), ("assignee", ME, BOB)]
    assert {h["author"] for h in history} == {ME}
    assert [h["text"] for h in history] == ["Status: In progress", "Status: Done", f"Assigned to {BOB}"]


async def test_a_save_that_changes_nothing_tracked_writes_nothing():
    task = await _task()
    task.priority = "high"
    await task.save()
    await task.save()
    assert await _history(task) == []


async def test_a_rename_is_history_too():
    task = await _task(title="Old name")
    task.title = "New name"
    await task.save()
    assert [(h["change"], h["from"], h["to"], h["text"]) for h in await _history(task)] == [
        ("title", "Old name", "New name", "Renamed to New name")]


async def test_a_hub_echo_of_the_other_persons_change_writes_nothing():
    task = await _task(assignee=BOB)
    task.status = "in_progress"
    with remote_reflection():
        await task.save()
    assert await _history(task) == []


async def test_a_disk_reindex_writes_nothing():
    task = await _task()
    task.status = "done"
    with suppress_store():
        await task.save()
    assert await _history(task) == []


async def test_a_delegated_task_is_left_to_the_ledger():
    task = await _task(owner=f"agent:{mint_uuid()}", creator=f"agent:{mint_uuid()}")
    task.status = "working"
    await task.save()
    assert await _history(task) == []


@pytest.mark.parametrize(
    ("field", "old", "new", "author", "said"),
    [
        ("status", "to_do", "in_progress", ME, "Status: In progress"),
        ("assignee", ME, BOB, ME, f"Assigned to {BOB}"),
        ("assignee", None, BOB, ME, f"Assigned to {BOB}"),
        ("assignee", BOB, "carol@example.test", ME, "Reassigned to carol@example.test"),
        ("assignee", BOB, None, ME, "Unassigned"),
    ],
)
def test_how_the_thread_says_a_change(field, old, new, author, said):
    assert task_changes.sentence(field, old, new, author=author) == said


async def test_the_assignees_change_on_a_task_received_from_the_hub_is_history():
    """A task received from the hub is stored with no creator stamp (``exist_in_db`` reads False) — its
    assignee's own moves are still changes, not creates."""
    task = await _task(assignee=ME, reporter=BOB, remote=True)
    task.created_by = None
    task.status = "in_progress"
    await task.save()
    assert [(h["change"], h["to"], h["author"]) for h in await _history(task)] == [("status", "in_progress", ME)]
