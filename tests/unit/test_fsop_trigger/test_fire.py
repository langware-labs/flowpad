"""Step 8: _fire(...) bookkeeping — counter bump, last_seen update, action dispatch, audit log.

`_fire` is the in-memory side of the fire path. The watcher (step 11) is responsible
for entity reload + persistence; `_fire` just mutates the passed Trigger and dispatches.
"""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.server.fsop_watcher import _fire


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


# ── helpers ───────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_callback_registry():
    snapshot = dict(trigger_callbacks._handlers)
    trigger_callbacks._handlers.clear()
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


@pytest.fixture
def trigger_log_dir(tmp_path, monkeypatch):
    """Redirect trigger-log dir into a temp space so append_entry has somewhere to write."""
    from flow_sdk.fs_store.operations import trigger_log as tl

    log_dir = tmp_path / "trigger_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(tl, "_trigger_log_dir", lambda: log_dir)
    return log_dir


def _make_trigger(
    name: str = "t",
    watch_path: str | None = None,
    actions: list[TriggerAction] | None = None,
    enabled: bool = True,
) -> Trigger:
    t = Trigger(
        name=name,
        trigger_type=TriggerType.FSOP,
        watch_path=watch_path,
        actions=actions or [],
        enabled=enabled,
    )
    t.id = f"id-{name}"
    return t


# ── counter + last_triggered ──────────────────────────────────────────────────


async def test_fire_bumps_counter(trigger_log_dir):
    t = _make_trigger(watch_path="/tmp/x")
    assert t.counter == 0
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert t.counter == 1


async def test_fire_updates_last_triggered(trigger_log_dir):
    t = _make_trigger(watch_path="/tmp/x")
    assert t.last_triggered is None
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert t.last_triggered is not None


# ── last_seen_* for file-mode triggers ────────────────────────────────────────


async def test_fire_updates_last_seen_for_file_mode(tmp_path, trigger_log_dir):
    target = tmp_path / "watched.txt"
    target.write_text("hello")
    t = _make_trigger(watch_path=str(target))

    await _fire(t, [ChangeEvent(path=target, change_type="modified")])
    st = target.stat()
    assert t.last_seen_mtime == st.st_mtime
    assert t.last_seen_size == st.st_size


async def test_fire_clears_last_seen_when_file_deleted(tmp_path, trigger_log_dir):
    target = tmp_path / "watched.txt"
    target.write_text("x")
    t = _make_trigger(watch_path=str(target))
    t.last_seen_mtime = 1234.0
    t.last_seen_size = 1

    target.unlink()
    await _fire(t, [ChangeEvent(path=target, change_type="deleted")])
    assert t.last_seen_mtime is None
    assert t.last_seen_size is None


async def test_fire_does_not_update_last_seen_for_folder_mode(tmp_path, trigger_log_dir):
    """Folder-mode trigger: changed_path is a child, not the watch_path itself — skip last_seen."""
    folder = tmp_path / "watched_folder"
    folder.mkdir()
    child = folder / "child.txt"
    child.write_text("c")
    t = _make_trigger(watch_path=str(folder))

    await _fire(t, [ChangeEvent(path=child, change_type="modified")])
    assert t.last_seen_mtime is None  # folder mode skips file-fingerprint
    assert t.last_seen_size is None


# ── enabled gate ──────────────────────────────────────────────────────────────


async def test_disabled_trigger_no_fire(trigger_log_dir):
    t = _make_trigger(watch_path="/tmp/x", enabled=False)
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert t.counter == 0
    assert t.last_triggered is None


# ── action dispatch ───────────────────────────────────────────────────────────


async def test_fire_dispatches_each_action_in_order(trigger_log_dir):
    """All actions in trigger.actions execute, in order."""
    calls: list[str] = []

    @trigger_callbacks.register("a")
    async def cb_a(*args, **kw):
        calls.append("a")

    @trigger_callbacks.register("b")
    async def cb_b(*args, **kw):
        calls.append("b")

    t = _make_trigger(
        watch_path="/tmp/x",
        actions=[
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="a"),
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="b"),
        ],
    )

    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert calls == ["a", "b"]


async def test_fire_continues_after_action_failure(trigger_log_dir):
    """If an action raises, subsequent actions still run."""
    calls: list[str] = []

    @trigger_callbacks.register("bad")
    async def cb_bad(*args, **kw):
        raise RuntimeError("kaboom")

    @trigger_callbacks.register("good")
    async def cb_good(*args, **kw):
        calls.append("good")

    t = _make_trigger(
        watch_path="/tmp/x",
        actions=[
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="bad"),
            TriggerAction(action_type=ActionType.CALLBACK, callback_name="good"),
        ],
    )

    # _fire must not propagate the inner exception
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert calls == ["good"]
    assert t.counter == 1  # counter still bumped


async def test_fire_with_empty_actions_just_bumps_counter(trigger_log_dir):
    t = _make_trigger(watch_path="/tmp/x", actions=[])
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    assert t.counter == 1


# ── audit log ─────────────────────────────────────────────────────────────────


async def test_fire_writes_trigger_log_entry(trigger_log_dir):
    t = _make_trigger(name="log_test", watch_path="/tmp/x")
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])

    log_file = trigger_log_dir / "log_test" / "calls.jsonl"
    assert log_file.exists()
    content = log_file.read_text()
    assert "log_test" in content
    assert "/tmp/x" in content
    assert "modified" in content


# ── bus emission ──────────────────────────────────────────────────────────────


async def test_fire_emits_exactly_one_envelope_per_batch(trigger_log_dir):
    """ONE `trigger.fired` per debounce window, matching the one log row.

    awatch's debounce IS the rate guard for fsop; a per-file emission would be
    the per-write lane that keeps `entity.*` off the forwarding allowlist.
    Falsifiable: move the emit into the raw-changes loop in `_run_watch_for`
    and this yields 50.
    """
    from flow_sdk.tags import event_bus

    t = _make_trigger(name="batch_test", watch_path="/tmp/x")
    fired = []
    unsub = event_bus.on("trigger.fired", fired.append)
    try:
        batch = [ChangeEvent(path=Path(f"/tmp/f{i}"), change_type="modified")
                 for i in range(50)]
        await _fire(t, batch)
    finally:
        unsub()

    assert len(fired) == 1, f"expected 1 envelope for a 50-file batch, got {len(fired)}"
    ev = fired[0]
    assert ev.target == "trigger:id-batch_test"
    assert ev.data["detail"]["changes_total"] == 50
    assert ev.data["detail"]["first_path"] == "/tmp/f0"
    assert ev.ctx.actor == "system"


async def test_log_row_and_envelope_are_the_same_fact(trigger_log_dir):
    """The row carries the envelope's id, so either side joins to the other.
    This is what `make_tag_event`/`publish` buy over `emit` — with emit's
    zero-subscriber fast path, `event_id` would be null whenever nobody was
    listening, and the join would work only half the time."""
    import json

    from flow_sdk.tags import event_bus

    t = _make_trigger(name="join_test", watch_path="/tmp/x")
    fired = []
    unsub = event_bus.on("trigger.fired", fired.append)
    try:
        await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])
    finally:
        unsub()

    row = json.loads((trigger_log_dir / "join_test" / "calls.jsonl").read_text().strip())
    assert row["event_id"] == fired[0].id
    assert row["trigger_id"] == "id-join_test"
    assert row["trigger_type"] == "fsop"


async def test_event_id_is_recorded_even_with_no_subscribers(trigger_log_dir):
    """The join key must not depend on whether anyone happened to be listening."""
    import json

    t = _make_trigger(name="nosub_test", watch_path="/tmp/x")
    await _fire(t, [ChangeEvent(path=Path("/tmp/x"), change_type="modified")])

    row = json.loads((trigger_log_dir / "nosub_test" / "calls.jsonl").read_text().strip())
    assert row["event_id"], "event_id must be present with zero bus subscribers"
