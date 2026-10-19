"""The task ledger: one writer of a delegated task's lifecycle — row, comment and bus event together."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task
from flow_sdk.schema.data_spec.task_spec import TaskStatus, status_family
from flow_sdk.tags import on_tag
from flow_sdk.tasks import ledger
from flow_sdk.tasks.ledger import TaskEvent, TaskLedgerError

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("bootstrapped_client")]  # do not increase timeout without approval

CREATOR = "agent:11111111-1111-4111-8111-111111111111"
OWNER = "subagent:general-worker"


class Heard(list):
    def __init__(self):
        super().__init__()

        async def _seen(event):
            self.append((event.tag, dict(event.data or {})))

        self.unsubscribe = on_tag("task.*", _seen)


@pytest.fixture
async def project(tmp_path):
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    root = tmp_path / "proj"
    root.mkdir()
    return await Project(id=mint_uuid(), name=f"ledger-{mint_uuid()[:8]}", fs_storage_mount_path=str(root)).save()


PROJECT: dict = {}


@pytest.fixture(autouse=True)
def _in_project(project):
    PROJECT["id"] = project.id


async def _task(**kw):
    kw.setdefault("creator", CREATOR)
    return await ledger.create(title=kw.pop("title", "Summarise the Q3 notes"), brief=kw.pop("brief", "Read notes/, write summary.md"),
                               owner=OWNER, origin_conversation=kw.pop("origin_conversation", "conv-1"),
                               project_id=PROJECT["id"], **kw)


async def test_a_task_lives_its_whole_life_through_the_ledger_row_comment_and_event_together():
    heard = Heard()
    try:
        task = await _task()
        assert task.status == TaskStatus.SUBMITTED and task.creator == CREATOR and task.owner == OWNER
        assert task.placement == "instance" and not task.asset_ref
        task = await ledger.record(task, TaskEvent.STARTED, author=OWNER, run="agentic_process-r1")
        task = await ledger.record(task, TaskEvent.NOTE, author=OWNER, text="read 4 of 9 files")
        task = await ledger.record(task, TaskEvent.ASKED, author=OWNER, text="Which quarter — fiscal or calendar?")
        assert task.status == TaskStatus.INPUT_REQUIRED
        task = await ledger.record(task, TaskEvent.REPLIED, author=CREATOR, text="Calendar.")
        assert task.status == TaskStatus.WORKING
        task = await ledger.record(task, TaskEvent.DONE, author=OWNER, result="summary.md written: 3 themes", cost_usd=0.04,
                                   artifacts=["notes/summary.md"])
        assert task.status == TaskStatus.DONE and task.completed_at and task.result.startswith("summary.md")
        assert task.process_id == "agentic_process-r1" and task.artifacts == ["notes/summary.md"]

        stored = await Task.get_by_id(task.id)
        assert stored.status == TaskStatus.DONE and stored.cost_usd == 0.04
        log = await ledger.comments(task)
        assert [(c.data["task_event"], c.data["author"]) for c in log] == [
            ("created", CREATOR), ("started", OWNER), ("note", OWNER), ("asked", OWNER), ("replied", CREATOR), ("done", OWNER),
        ]
        assert log[3].data["text"] == "Which quarter — fiscal or calendar?"
        assert [tag for tag, _ in heard] == ["task.created", "task.started", "task.note", "task.asked", "task.replied", "task.done"]
        assert heard[-1][1]["origin_conversation"] == "conv-1" and heard[-1][1]["owner"] == OWNER
    finally:
        heard.unsubscribe()


@pytest.mark.parametrize(("event", "author", "why"), [
    (TaskEvent.DONE, CREATOR, "only its owner"),
    (TaskEvent.CANCELED, OWNER, "only its creator, system"),
    (TaskEvent.STARTED, "agent:someone-else", "only its owner, system"),
    (TaskEvent.ASKED, OWNER, "only a working task can ask"),
])
async def test_the_ledger_refuses_a_change_out_of_turn(event, author, why):
    task = await _task()
    with pytest.raises(TaskLedgerError, match=why):
        await ledger.record(task, event, author=author)


async def test_a_finished_task_takes_no_more_events():
    task = await _task()
    task = await ledger.record(task, TaskEvent.CANCELED, author=CREATOR, text="not needed")
    with pytest.raises(TaskLedgerError, match="nothing more happens"):
        await ledger.record(task, TaskEvent.STARTED, author=OWNER)


async def test_open_tasks_are_a_principals_unfinished_ones_by_conversation():
    mine = await _task(title="a")
    await _task(title="b")
    done = await _task(title="c")
    await ledger.record(done, TaskEvent.FAILED, author="system", text="budget")
    other = await _task(title="d", creator="agent:other", origin_conversation="conv-2")
    ids = {t.id for t in await ledger.open_tasks(principal=CREATOR, origin_conversation="conv-1")}
    assert mine.id in ids and done.id not in ids and other.id not in ids


def test_every_status_sits_on_the_three_bucket_board():
    assert [status_family(s) for s in ("submitted", "working", "input_required", "failed", "canceled", "to_do", "nonsense")] == [
        "to_do", "in_progress", "in_progress", "done", "done", "to_do", "to_do",
    ]


def _files_under(root) -> list[str]:
    from pathlib import Path  # noqa: PLC0415

    return sorted(str(p.relative_to(root)) for p in Path(root).rglob("*") if p.is_file())


async def test_a_delegated_task_never_touches_the_project_tree(project):
    """Runtime state is not authored configuration: a delegated task lives in the instance (DB +
    records shadow), not in the project's git tree — through its whole life."""
    task = await _task()
    task = await ledger.record(task, TaskEvent.STARTED, author=OWNER)
    task = await ledger.record(task, TaskEvent.DONE, author=OWNER, result="ok")
    assert _files_under(project.fs_storage_mount_path) == []
    assert not task.is_file_backed() and not task.asset_ref

    stored = await Task.get_by_id(task.id)
    assert stored is not None and stored.placement == "instance" and stored.status == TaskStatus.DONE
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    listed = await Task.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.EQ, operands=["project_id", project.id])))
    assert task.id in {t.id for t in listed}


async def test_keep_promotes_a_delegated_task_into_the_project(project):
    task = await _task(title="Draft the launch note")
    kept = await ledger.keep(task.id)
    assert kept.placement == "repo" and kept.asset_ref and kept.is_file_backed()
    files = _files_under(project.fs_storage_mount_path)
    assert any(f.endswith("task.md") and "agentic-assets/task/" in f for f in files), files
    assert (await ledger.keep(kept)).asset_ref == kept.asset_ref  # idempotent


async def test_a_delegated_task_cannot_hang_under_a_shared_task(project):
    shared = await Task(title="shared", project_id=project.id, remote=True).save()
    with pytest.raises(TaskLedgerError, match="shared"):
        await _task(parent_id=shared.id)
