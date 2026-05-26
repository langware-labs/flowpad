"""Step 11: _run_watch_for + FSOpWatcher — the awatch integration.

End-to-end: a Trigger configured with watch_path → file event on disk →
_run_watch_for catches it → _fire dispatches the action.

Uses real watchfiles (no mocks per `feedback_no_mocks_in_integration_tests`).
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


# Watchfiles takes ~50-200ms to detect file changes (poll interval + filesystem latency).
_AWATCH_SETTLE = 0.3
_AWATCH_TIMEOUT = 3.0


@pytest.fixture(autouse=True)
def _isolate_callback_registry():
    snapshot = dict(trigger_callbacks._handlers)
    trigger_callbacks._handlers.clear()
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


@pytest.fixture
def trigger_log_dir(tmp_path, monkeypatch):
    from flow_sdk.fs_records import trigger_log as tl

    log_dir = tmp_path / "trigger_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(tl, "_trigger_log_dir", lambda: log_dir)
    return log_dir


async def _wait_for(predicate, timeout: float = _AWATCH_TIMEOUT, interval: float = 0.05) -> bool:
    """Poll until predicate() is truthy or timeout. Returns True if predicate was met."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return False


def _make_callback_trigger(
    watch_path: Path,
    callback_name: str = "test_cb",
    recursive: bool = False,
    watch_glob: str | None = None,
) -> Trigger:
    t = Trigger(
        name=f"t_{callback_name}",
        trigger_type=TriggerType.FSOP,
        watch_path=str(watch_path),
        recursive=recursive,
        watch_glob=watch_glob,
        actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name=callback_name)],
    )
    t.id = f"id_{callback_name}"
    return t


# ── file mode ────────────────────────────────────────────────────────────────


async def test_file_change_fires(tmp_path, trigger_log_dir):
    """Modifying the watched file fires the trigger's CALLBACK action."""
    from flow_sdk.server.fsop_watcher import _run_watch_for

    target = tmp_path / "watched.txt"
    target.write_text("initial")

    calls: list[Path] = []

    @trigger_callbacks.register("cb_file")
    async def on_change(trigger, changes):
        calls.append(changes[0].path)

    t = _make_callback_trigger(target, callback_name="cb_file")

    task = asyncio.create_task(_run_watch_for(t))
    await asyncio.sleep(_AWATCH_SETTLE)  # let awatch begin

    target.write_text("modified")
    got = await _wait_for(lambda: len(calls) > 0)

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert got, "Expected callback to fire after file modification"
    assert calls[0] == target


async def test_unrelated_file_in_same_dir_no_fire(tmp_path, trigger_log_dir):
    """Modifying a sibling file in the same dir does NOT fire the trigger.

    Initial create events for the watched file itself may leak during the
    settle window, so we filter calls to specifically check no SIBLING fires.
    """
    from flow_sdk.server.fsop_watcher import _run_watch_for

    target = tmp_path / "a.json"
    target.write_text("{}")
    unrelated = tmp_path / "b.json"
    unrelated.write_text("{}")

    calls: list[Path] = []

    @trigger_callbacks.register("cb_unrelated")
    async def on_change(trigger, changes):
        calls.append(changes[0].path)

    t = _make_callback_trigger(target, callback_name="cb_unrelated")

    task = asyncio.create_task(_run_watch_for(t))
    await asyncio.sleep(_AWATCH_SETTLE)
    unrelated.write_text("modified")
    await asyncio.sleep(0.5)  # give it a chance to (incorrectly) fire

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    sibling_fires = [c for c in calls if c == unrelated]
    assert sibling_fires == [], f"Sibling file change should not fire trigger; got {sibling_fires}"


async def test_cancel_stops_loop(tmp_path, trigger_log_dir):
    """Cancelling the task stops the awatch loop cleanly; subsequent changes don't fire.

    We can't assume no events fire before the cancel (the initial file-creation
    event may be delivered to awatch during the settle window). Instead we
    snapshot the count at cancel time and check it doesn't grow afterwards.
    """
    from flow_sdk.server.fsop_watcher import _run_watch_for

    target = tmp_path / "x.txt"
    target.write_text("x")

    calls: list[Path] = []

    @trigger_callbacks.register("cb_cancel")
    async def on_change(trigger, changes):
        calls.append(changes[0].path)

    t = _make_callback_trigger(target, callback_name="cb_cancel")
    task = asyncio.create_task(_run_watch_for(t))
    await asyncio.sleep(_AWATCH_SETTLE)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    baseline = len(calls)

    # Now modify — must NOT fire (task is dead)
    target.write_text("after_cancel")
    await asyncio.sleep(0.5)
    assert len(calls) == baseline, f"Post-cancel write should not fire; baseline={baseline}, got {len(calls)}"


# ── folder mode ──────────────────────────────────────────────────────────────


async def test_folder_change_fires_on_child(tmp_path, trigger_log_dir):
    """Folder-mode trigger: modifying any child in the folder fires."""
    from flow_sdk.server.fsop_watcher import _run_watch_for

    folder = tmp_path / "watched_folder"
    folder.mkdir()

    calls: list[Path] = []

    @trigger_callbacks.register("cb_folder")
    async def on_change(trigger, changes):
        calls.append(changes[0].path)

    t = _make_callback_trigger(folder, callback_name="cb_folder")
    task = asyncio.create_task(_run_watch_for(t))
    await asyncio.sleep(_AWATCH_SETTLE)

    (folder / "new_child.txt").write_text("hi")
    await _wait_for(lambda: len(calls) > 0)

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert len(calls) >= 1, f"Expected at least one fire on child change; got {calls}"


async def test_folder_recursive_false_ignores_subtree(tmp_path, trigger_log_dir):
    """recursive=False: changes in subdirectories don't fire."""
    from flow_sdk.server.fsop_watcher import _run_watch_for

    folder = tmp_path / "watched"
    folder.mkdir()
    sub = folder / "sub"
    sub.mkdir()

    calls: list[Path] = []

    @trigger_callbacks.register("cb_nonrec")
    async def on_change(trigger, changes):
        calls.append(changes[0].path)

    t = _make_callback_trigger(folder, callback_name="cb_nonrec", recursive=False)
    task = asyncio.create_task(_run_watch_for(t))
    await asyncio.sleep(_AWATCH_SETTLE)

    (sub / "deep.txt").write_text("deep")
    await asyncio.sleep(0.5)

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert calls == [], "recursive=False should NOT see subdirectory changes"


# ── FSOpWatcher singleton ────────────────────────────────────────────────────


async def test_watcher_spawns_task_for_trigger(tmp_path, trigger_log_dir):
    """FSOpWatcher.on_trigger_saved spawns a task for the given trigger."""
    from flow_sdk.server.fsop_watcher import FSOpWatcher

    target = tmp_path / "x.txt"
    target.write_text("x")
    t = _make_callback_trigger(target, callback_name="cb_singleton")
    t.id = "singleton-1"

    @trigger_callbacks.register("cb_singleton")
    async def on_change(trigger, changes):
        pass

    watcher = FSOpWatcher()
    await watcher.on_trigger_saved(t)
    try:
        assert t.id in watcher._tasks
        assert not watcher._tasks[t.id].done()
    finally:
        await watcher.stop()


async def test_watcher_on_trigger_deleted_cancels_task(tmp_path, trigger_log_dir):
    from flow_sdk.server.fsop_watcher import FSOpWatcher

    target = tmp_path / "x.txt"
    target.write_text("x")
    t = _make_callback_trigger(target, callback_name="cb_del")
    t.id = "del-1"

    @trigger_callbacks.register("cb_del")
    async def on_change(*a, **kw):
        pass

    watcher = FSOpWatcher()
    await watcher.on_trigger_saved(t)
    assert t.id in watcher._tasks

    await watcher.on_trigger_deleted(t.id)
    assert t.id not in watcher._tasks


async def test_watcher_stop_cancels_all_tasks(tmp_path, trigger_log_dir):
    from flow_sdk.server.fsop_watcher import FSOpWatcher

    @trigger_callbacks.register("cb_stop")
    async def on_change(*a, **kw):
        pass

    targets = [tmp_path / f"f{i}.txt" for i in range(3)]
    for p in targets:
        p.write_text("x")

    watcher = FSOpWatcher()
    for i, p in enumerate(targets):
        t = _make_callback_trigger(p, callback_name="cb_stop")
        t.id = f"multi-{i}"
        await watcher.on_trigger_saved(t)

    assert len(watcher._tasks) == 3
    await watcher.stop()
    assert len(watcher._tasks) == 0


async def test_watcher_on_trigger_saved_replaces_existing_task(tmp_path, trigger_log_dir):
    """Saving the same trigger id twice cancels the old task and spawns a new one."""
    from flow_sdk.server.fsop_watcher import FSOpWatcher

    @trigger_callbacks.register("cb_replace")
    async def on_change(*a, **kw):
        pass

    target = tmp_path / "x.txt"
    target.write_text("x")
    t1 = _make_callback_trigger(target, callback_name="cb_replace")
    t1.id = "replace-1"

    watcher = FSOpWatcher()
    await watcher.on_trigger_saved(t1)
    task1 = watcher._tasks[t1.id]

    # Save again (same id) — task should be replaced
    await watcher.on_trigger_saved(t1)
    task2 = watcher._tasks[t1.id]
    try:
        assert task1 is not task2, "Re-save should replace the task"
        assert task1.cancelled() or task1.done(), "Old task should be cancelled"
    finally:
        await watcher.stop()
