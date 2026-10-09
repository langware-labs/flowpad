"""The ``task_manager`` source: tasks as a channel, pulled like any other.

The source holds no state of its own — it lists the principal's tasks and their comments from the
graph — so these run against the test DB: the contract (conformance kit), who a task involves, what a
thread says, that a second pull lists the same keys, and that sending writes a comment (a ledger
``replied`` on a delegated task).
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.task import Task
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources import CloudOrigin
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import MessageData

source_module = asset_module("task_manager")
TaskManagerSource = source_module.TaskManagerSource
involves = source_module.involves

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def blob_storage(tmp_path):
    """Blob-storage fallback so a Comment (its body is a blob) saves outside a service context."""
    from flow_sdk.config import default_service_config  # noqa: PLC0415
    from flow_sdk.request_context import methods as _ctx  # noqa: PLC0415
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver  # noqa: PLC0415

    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev

ALICE = "alice@example.test"
BOB = "bob@example.test"


def _source(principal: str, email: str = "") -> TaskManagerSource:
    config = {"principal": principal, **({"email": email} if email else {})}
    return TaskManagerSource(SourceBinding(account_key=principal, config=config))


async def _task(**fields) -> Task:
    return await Task(placement="instance", **{"title": f"task {mint_uuid()[:8]}", **fields}).save()


async def _keys(source: TaskManagerSource) -> list[str]:
    async with source:
        return [item.origin.key async for item in source.iterate()]


@pytest.mark.parametrize("check", checks_for(TaskManagerSource), ids=str)
async def test_conformance(check):
    principal = f"user:{mint_uuid()}@example.test"
    email = principal.split(":", 1)[1]
    tasks = [await _task(reporter=email, assignee=BOB, status="in_progress") for _ in range(2)]
    source = _source(principal)
    seeded = tuple(source.origin(f"{t.id}:created", "tasks", t.id) for t in tasks)
    await Comment(raw_content="hello", parent_type_id=str(tasks[0].typeid), data={"author": BOB, "text": "hello"}).save(tasks[0].typeid)
    await check.run(Subject(
        source=lambda: _source(principal),
        seeded=seeded,
        conversation=source.thread(tasks[0].id),
        # A Tasks message goes into a task's thread; sending to people is declared Unsupported.
        recipient=_profile(BOB),
    ))


def _profile(who: str):
    from flow_sdk.sources.values.items import UserProfile  # noqa: PLC0415

    return UserProfile(origin=CloudOrigin(kind="tasks", namespace="principals", key=who), name=who)


@pytest.mark.parametrize(
    ("fields", "principal", "email", "expected"),
    [
        ({"creator": "agent:a1", "owner": "subagent:w"}, "agent:a1", "", True),
        ({"creator": "agent:a2", "owner": "agent:a1"}, "agent:a1", "", True),
        ({"creator": "agent:a2", "owner": "subagent:w", "assignee": ALICE}, "agent:a1", "", False),
        ({"assignee": ALICE}, "user:local", ALICE, True),
        ({"reporter": ALICE, "assignee": BOB}, "user:local", ALICE, True),
        ({"reporter": "Alice@Example.test"}, "user:local", ALICE, True),
        ({"reporter": BOB, "assignee": BOB}, "user:local", ALICE, False),
        ({"assignee": ALICE}, "user:local", "", False),
        ({"creator": "user:local"}, "user:local", "", True),
        ({"assignee": ALICE}, f"user:{ALICE}", "", True),
    ],
)
def test_who_a_task_involves(fields, principal, email, expected):
    assert involves(Task(**fields), principal, email) is expected


async def test_a_plain_task_is_a_thread_root_then_its_comments():
    me = f"{mint_uuid()[:8]}@example.test"
    task = await _task(reporter=me, assignee=BOB, status="in_progress", description="Set up the studio.")
    await Comment(raw_content="On it", parent_type_id=str(task.typeid), data={"author": BOB, "text": "On it"}).save(task.typeid)
    source = _source("user:local", me)
    async with source:
        items = {item.origin.key: item async for item in source.iterate() if item.data.task_id == task.id}

    root = items.pop(f"{task.id}:created")
    assert root.data.text == "Set up the studio." and root.data.subject == task.title
    assert root.data.conversation == source.thread(task.id)
    assert root.data.sender.origin.key == "user:local"  # my own words are keyed by the row's address
    (comment,) = items.values()  # nothing read off the row's state: no snapshot of its status or assignee
    assert comment.data.text == "On it" and comment.data.sender.origin.key == BOB


async def test_a_new_task_is_just_its_root():
    me = f"{mint_uuid()[:8]}@example.test"
    task = await _task(reporter=me, assignee=me)
    keys = [k for k in await _keys(_source("user:local", me)) if k.startswith(task.id)]
    assert keys == [f"{task.id}:created"]


async def test_a_second_pull_lists_the_same_messages():
    me = f"{mint_uuid()[:8]}@example.test"
    await _task(reporter=me, assignee=BOB, status="done")
    source_a, source_b = _source("user:local", me), _source("user:local", me)
    async with source_a:
        first = [(i.origin, i.data) async for i in source_a.iterate()]
    async with source_b:
        second = [(i.origin, i.data) async for i in source_b.iterate()]
    assert first == second


async def test_a_delegated_task_is_exactly_its_ledger_log():
    from flow_sdk.tasks import ledger  # noqa: PLC0415

    principal = f"agent:{mint_uuid()}"
    task = await ledger.create(title="Delegated", brief="Do it.", creator=principal, owner=f"agent:{mint_uuid()}")
    source = _source(principal)
    async with source:
        items = [i async for i in source.iterate() if i.data.task_id == task.id]
    assert len(items) == 1
    (created,) = items
    assert created.data.task_event == "created" and created.data.quiet
    assert created.data.text.startswith(f"[task {task.id} · created · by {principal}] Delegated")
    assert created.data.sender.origin.key == principal


async def test_sending_into_a_task_thread_writes_a_comment_the_next_pull_lists():
    me = f"{mint_uuid()[:8]}@example.test"
    task = await _task(reporter=me, assignee=BOB)
    source = _source("user:local", me)
    async with source:
        sent = await source.send(MessageData(text="Any update?", conversation=source.thread(task.id)))
        listed = {i.origin: i async for i in source.iterate()}
    comments = await Comment.get_all({"parent_type_id": str(task.typeid)})
    assert [(c.data or {}).get("text") for c in comments] == ["Any update?"]  # raw_content is a blob a list leaves out
    assert (comments[0].data or {}).get("author") == me
    assert sent.origin in listed and listed[sent.origin].data.text == "Any update?"
    assert sent.data.sender.origin.key == "user:local"


async def test_replying_on_a_delegated_task_is_the_ledgers_replied():
    from flow_sdk.tasks import ledger  # noqa: PLC0415

    principal = f"agent:{mint_uuid()}"
    task = await ledger.create(title="Ask me", brief="?", creator=principal, owner=f"agent:{mint_uuid()}")
    source = _source(principal)
    async with source:
        sent = await source.send(MessageData(text="Here you go", conversation=source.thread(task.id)))
    log = await ledger.comments(task)
    assert [(c.data or {}).get("task_event") for c in log] == ["created", "replied"]
    assert sent.origin.key == f"{task.id}:{log[-1].id}"


async def test_a_thread_of_a_task_this_principal_is_not_in_is_not_found():
    from flow_sdk.sources.errors import NotFound  # noqa: PLC0415

    task = await _task(reporter=BOB, assignee=BOB)
    source = _source("user:local", ALICE)
    async with source:
        with pytest.raises(NotFound):
            await source.send(MessageData(text="hi", conversation=source.thread(task.id)))


def test_the_bus_says_pull_only_for_tasks_and_their_comments():
    assert TaskManagerSource.wants("task.done", {})
    assert TaskManagerSource.wants("entity.updated", {"entity_type": "task", "id": "x"})
    assert TaskManagerSource.wants("entity.created", {"entity_type": "comment", "id": "x"})
    assert not TaskManagerSource.wants("entity.updated", {"entity_type": "source_item", "id": "x"})
    assert not TaskManagerSource.wants("entity.updated", {"entity_type": "data_source", "id": "x"})


# ── history: one message per change (``task_changes`` comments) ─────────────────────────────────────
@pytest.fixture
def logged_in_as(monkeypatch):
    """Who this instance is — the author ``task_changes`` stamps on a change made here."""
    import flow_sdk.cli.app_config as app_config  # noqa: PLC0415

    def login(email: str) -> str:
        monkeypatch.setattr(app_config, "get_user", lambda: {"email": email})
        return email

    return login


async def test_every_change_is_its_own_message_credited_to_who_made_it(logged_in_as):
    me = logged_in_as(f"{mint_uuid()[:8]}@example.test")
    task = await _task(reporter=me, assignee=me)
    task.assignee = BOB
    await task.save()
    for status in ("done", "in_progress", "done"):
        task.status = status
        await task.save()
    # The other person's move, as the hub delivers it: their change comment, authored by them.
    await Comment(raw_content="Status: Done", parent_type_id=str(task.typeid), remote=True,
                  data={"change": "status", "from": "done", "to": "done", "author": BOB, "text": "Status: Done"}).save(task.typeid)

    source = _source("user:local", me)
    async with source:
        items = [i async for i in source.iterate() if i.data.task_id == task.id]
    texts = [i.data.text for i in items if not i.origin.key.endswith(":created")]
    assert texts.count("Status: Done") == 3 and texts.count("Status: In progress") == 1, texts
    assert f"Assigned to {BOB}" in texts
    by_bob = [i for i in items if i.data.sender.origin.key == BOB]
    assert [i.data.text for i in by_bob] == ["Status: Done"]


async def test_the_threads_root_carries_the_task():
    me = f"{mint_uuid()[:8]}@example.test"
    task = await _task(reporter=me, assignee=me)
    source = _source("user:local", me)
    async with source:
        (root,) = [i async for i in source.iterate() if i.origin.key == f"{task.id}:created"]
    assert root.data.refs == (f"task-{task.id}",)
    assert root.data.recipients == (), "a task thread is addressed by itself, never by a person"


async def test_a_task_handed_away_keeps_its_thread_for_who_had_it(logged_in_as):
    bob = f"bob-{mint_uuid()[:8]}@example.test"
    carol = f"carol-{mint_uuid()[:8]}@example.test"
    logged_in_as("alice@example.test")
    task = await _task(reporter="alice@example.test", assignee=bob)
    task.assignee = carol
    await task.save()  # alice's reassignment — on bob's machine it arrives as this comment + the new row

    source = _source("user:local", bob)
    async with source:
        items = [i async for i in source.iterate() if i.data.task_id == task.id]
    assert any(i.data.text == f"Reassigned to {carol}" for i in items), [i.data.text for i in items]


async def test_a_resumed_pull_pages_to_its_end():
    """A pull resumed from where the last one stopped, over more than one page: each next page keeps the
    resumed floor — a page token alone belongs to another query and is refused."""
    me = f"{mint_uuid()[:8]}@example.test"
    tasks = [await _task(reporter=me, assignee=me) for _ in range(3)]
    source = _source("user:local", me)
    async with source:
        keys, cursor = [], "since:2026-01-01T00:00:00+00:00"  # old: re-reads the window — pages of one
        for _ in range(500):
            page = await source.fetch(cursor, page_size=1)
            keys += [i.origin.key for i in page.items]
            if page.next_cursor is None:
                break
            cursor = page.next_cursor
    assert {f"{t.id}:created" for t in tasks} <= set(keys)
