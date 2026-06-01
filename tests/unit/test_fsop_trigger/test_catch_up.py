"""Step 9: _catch_up_if_changed — replay file changes missed while the server was down.

For each FSOp file-mode trigger on startup, compare stored last_seen_mtime/size
to the file's current stat. If they diverge (file changed/created/deleted while
the server was down), synthesize a fire so consumers catch up.

Folder-mode triggers skip catch-up (no single fingerprint).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.server.fsop_watcher import _catch_up_if_changed


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolate_callback_registry():
    snapshot = dict(trigger_callbacks._handlers)
    trigger_callbacks._handlers.clear()
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


@pytest.fixture
def trigger_log_dir(tmp_path, monkeypatch):
    from flow_sdk.fs_store.operations import trigger_log as tl

    log_dir = tmp_path / "trigger_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(tl, "_trigger_log_dir", lambda: log_dir)
    return log_dir


def _make_file_trigger(watch_path: Path) -> Trigger:
    t = Trigger(
        name="ft",
        trigger_type=TriggerType.FSOP,
        watch_path=str(watch_path),
    )
    t.id = "id-ft"
    return t


def _make_folder_trigger(watch_path: Path) -> Trigger:
    t = Trigger(
        name="folt",
        trigger_type=TriggerType.FSOP,
        watch_path=str(watch_path),
        recursive=True,
    )
    t.id = "id-folt"
    return t


def _stat_fingerprint(p: Path) -> tuple[float, int]:
    st = p.stat()
    return st.st_mtime, st.st_size


# ── no change cases ──────────────────────────────────────────────────────────


async def test_no_change_no_fire(tmp_path, trigger_log_dir):
    f = tmp_path / "a.txt"
    f.write_text("hello")
    t = _make_file_trigger(f)
    t.last_seen_mtime, t.last_seen_size = _stat_fingerprint(f)

    await _catch_up_if_changed(t)

    assert t.counter == 0


# ── mtime / size change cases ────────────────────────────────────────────────


async def test_mtime_change_fires(tmp_path, trigger_log_dir):
    f = tmp_path / "a.txt"
    f.write_text("hello")
    t = _make_file_trigger(f)
    t.last_seen_mtime, t.last_seen_size = _stat_fingerprint(f)

    # Bump mtime forward
    future = t.last_seen_mtime + 100
    os.utime(f, (future, future))

    await _catch_up_if_changed(t)
    assert t.counter == 1


async def test_size_change_fires(tmp_path, trigger_log_dir):
    f = tmp_path / "a.txt"
    f.write_text("hello")
    t = _make_file_trigger(f)
    t.last_seen_mtime, t.last_seen_size = _stat_fingerprint(f)

    f.write_text("hello world")  # size + mtime change
    await _catch_up_if_changed(t)
    assert t.counter == 1


# ── existence transitions ────────────────────────────────────────────────────


async def test_file_appears_fires(tmp_path, trigger_log_dir):
    """File didn't exist when last seen; now it does → fire."""
    f = tmp_path / "appears.txt"
    t = _make_file_trigger(f)
    # last_seen is None (file never existed at last fire)
    assert t.last_seen_mtime is None and t.last_seen_size is None

    f.write_text("hi")
    await _catch_up_if_changed(t)
    assert t.counter == 1


async def test_file_deleted_fires(tmp_path, trigger_log_dir):
    """File was seen last time; now it's gone → fire."""
    f = tmp_path / "doomed.txt"
    f.write_text("x")
    t = _make_file_trigger(f)
    t.last_seen_mtime, t.last_seen_size = _stat_fingerprint(f)
    f.unlink()

    await _catch_up_if_changed(t)
    assert t.counter == 1


async def test_file_never_existed_no_fire(tmp_path, trigger_log_dir):
    """File didn't exist before, still doesn't → no fire (no change to catch up on)."""
    f = tmp_path / "never_existed.txt"
    t = _make_file_trigger(f)
    await _catch_up_if_changed(t)
    assert t.counter == 0


# ── post-fire updates ────────────────────────────────────────────────────────


async def test_catch_up_updates_last_seen(tmp_path, trigger_log_dir):
    """After catch-up fires, last_seen reflects the post-fire file state."""
    f = tmp_path / "a.txt"
    f.write_text("hello")
    t = _make_file_trigger(f)
    # No prior last_seen → catch-up should fire
    await _catch_up_if_changed(t)
    expected = _stat_fingerprint(f)
    assert t.last_seen_mtime == expected[0]
    assert t.last_seen_size == expected[1]


# ── folder mode skips ────────────────────────────────────────────────────────


async def test_folder_trigger_skips_catch_up(tmp_path, trigger_log_dir):
    """Folder-mode triggers (recursive=True or watch_path is a dir) skip catch-up."""
    folder = tmp_path / "watched"
    folder.mkdir()
    (folder / "x.txt").write_text("x")

    t = _make_folder_trigger(folder)
    await _catch_up_if_changed(t)
    assert t.counter == 0


async def test_folder_trigger_by_dir_path_skips_catch_up(tmp_path, trigger_log_dir):
    """Even without recursive=True, if watch_path is a directory, skip catch-up."""
    folder = tmp_path / "watched"
    folder.mkdir()

    t = Trigger(name="folt2", trigger_type=TriggerType.FSOP, watch_path=str(folder))
    t.id = "id-folt2"
    await _catch_up_if_changed(t)
    assert t.counter == 0


# ── disabled triggers ────────────────────────────────────────────────────────


async def test_disabled_trigger_does_not_catch_up(tmp_path, trigger_log_dir):
    """Disabled triggers skip catch-up (would no-op inside _fire anyway, but cleaner to short-circuit)."""
    f = tmp_path / "a.txt"
    f.write_text("hi")
    t = _make_file_trigger(f)
    t.enabled = False
    # File changed but trigger is disabled → no fire
    await _catch_up_if_changed(t)
    assert t.counter == 0
