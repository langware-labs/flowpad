"""FSOpWatcher — runtime for FSOp triggers.

Owns one asyncio.Task per FSOp trigger running `watchfiles.awatch`; translates
file events into `_fire(...)` which does in-memory bookkeeping + action dispatch.
"""
from __future__ import annotations

import asyncio
import fnmatch
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.builtin.hook_models import get_action_handler
from flow_sdk.builtin.trigger import Trigger, TriggerType

_log = logging.getLogger(__name__)


async def _fire(trigger: Trigger, changed_path: Path, change_type: Any) -> None:
    """Apply a file-change event to a trigger.

    Mirrors `_fire_schedule_job` (trigger.py): bumps counter, sets last_triggered
    + last_seen_*, persists the bookkeeping via `await trigger.update()` so the
    UI counter reflects the fire, then dispatches actions + writes TriggerLogRecord.
    """
    if not trigger.enabled:
        return

    trigger.counter += 1
    trigger.last_triggered = datetime.now(timezone.utc)

    if trigger.watch_path and str(changed_path) == trigger.watch_path:
        try:
            st = changed_path.stat()
            trigger.last_seen_mtime = st.st_mtime
            trigger.last_seen_size = st.st_size
        except FileNotFoundError:
            trigger.last_seen_mtime = None
            trigger.last_seen_size = None

    # Persist counter/last_triggered/last_seen_* so the UI reflects the fire.
    if trigger.id:
        try:
            await trigger.update()
        except Exception:
            _log.exception("Trigger %s: failed to persist counter/last_triggered", trigger.name)

    # Per-action try so one bad handler doesn't skip the rest.
    for action in trigger.actions:
        try:
            handler = get_action_handler(action.action_type)
            if handler is None:
                _log.warning(
                    "Trigger %s: no handler for action_type=%s",
                    trigger.name,
                    action.action_type,
                )
                continue
            await handler.execute(trigger, action=action, changed_path=changed_path, change_type=change_type)
        except Exception:
            _log.exception(
                "Trigger %s: action %s raised during dispatch", trigger.name, action.action_type
            )

    try:
        from flow_sdk.fs_records.trigger_log import TriggerLogRecord

        TriggerLogRecord.append_entry(
            trigger.name,
            {
                "hook_event": "file_change",
                "trigger": True,
                # TriggerLogRecord whitelists fields; encode change_type+path in `reason`.
                "reason": f"File {change_type}: {changed_path}",
                "is_test": False,
                "rule_name": trigger.name,
                "actions": [{"action_type": str(a.action_type)} for a in trigger.actions],
                "agentic_process_id": None,
            },
        )
    except Exception:
        _log.exception("Trigger %s: failed to append TriggerLogRecord entry", trigger.name)


async def _catch_up_if_changed(trigger: Trigger) -> None:
    """Replay file-mode changes missed while the server was down.
    Folder-mode triggers are skipped — no single fingerprint for children.
    """
    if not trigger.enabled or not trigger.watch_path:
        return

    path = Path(trigger.watch_path)

    # Skip folder-mode triggers — no manifest comparison in v1.
    if trigger.recursive or path.is_dir():
        return

    exists = path.exists()
    had_seen = trigger.last_seen_mtime is not None or trigger.last_seen_size is not None

    if not exists and not had_seen:
        return  # never existed at either checkpoint
    if not exists and had_seen:
        await _fire(trigger, path, "deleted")
        return
    if exists and not had_seen:
        await _fire(trigger, path, "added")
        return

    # Both endpoints have the file — compare fingerprints.
    st = path.stat()
    if st.st_mtime != trigger.last_seen_mtime or st.st_size != trigger.last_seen_size:
        await _fire(trigger, path, "modified")


# ── per-trigger awatch loop ───────────────────────────────────────────────────


async def _run_watch_for(trigger: Trigger) -> None:
    """Per-trigger awatch loop. File-mode watches the parent dir + exact-path
    filter (survives atomic-rename inode swaps); folder-mode watches the dir.
    Exits cleanly on CancelledError.
    """
    from watchfiles import awatch

    if not trigger.watch_path:
        _log.warning("Trigger %s has no watch_path; nothing to watch", trigger.name)
        return

    watched_path = Path(trigger.watch_path)
    is_folder = watched_path.is_dir() or trigger.recursive
    watch_dir = watched_path if is_folder else watched_path.parent
    if not watch_dir.exists():
        _log.warning("Trigger %s: watch dir %s does not exist; skipping", trigger.name, watch_dir)
        return

    target_resolved = watched_path.resolve()
    glob_pattern = trigger.watch_glob

    def _match(_change_type: Any, raw_path: str) -> bool:
        p = Path(raw_path)
        try:
            resolved = p.resolve()
        except OSError:
            return False
        if is_folder:
            try:
                rel = resolved.relative_to(target_resolved)
            except ValueError:
                return False
            if not trigger.recursive:
                # macOS FSEvents reports the parent dir itself + subdir events;
                # restrict to single-segment file paths only.
                if len(rel.parts) != 1 or resolved.is_dir():
                    return False
            if glob_pattern and not fnmatch.fnmatch(p.name, glob_pattern):
                return False
            return True
        return resolved == target_resolved

    try:
        async for changes in awatch(
            str(watch_dir),
            recursive=trigger.recursive,
            watch_filter=_match,
        ):
            for change_type, raw_path in changes:
                changed = Path(raw_path)
                change_name = getattr(change_type, "name", None) or str(change_type)
                try:
                    await _fire(trigger, changed, change_name)
                except Exception:
                    _log.exception(
                        "Trigger %s: _fire raised for %s", trigger.name, raw_path
                    )
    except asyncio.CancelledError:
        raise
    except Exception:
        _log.exception("Trigger %s: watch loop crashed", trigger.name)


# ── singleton runtime ─────────────────────────────────────────────────────────


class FSOpWatcher:
    """Owns per-trigger asyncio.Tasks running `_run_watch_for`.
    Singleton in normal use; tests construct multiple instances against tmp_path.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}

    def __len__(self) -> int:
        return len(self._tasks)

    async def start(self) -> None:
        """Walk existing FSOp triggers, catch up on missed changes, spawn tasks."""
        triggers = await Trigger.list_by_type(TriggerType.FSOP)
        for t in triggers:
            try:
                await _catch_up_if_changed(t)
            except Exception:
                _log.exception("Trigger %s: catch-up failed", t.name)
            self._spawn_task(t)

    async def stop(self) -> None:
        """Cancel all tasks and await their cleanup."""
        if not self._tasks:
            return
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    async def on_trigger_saved(self, trigger: Trigger) -> None:
        """Called by the entity save lifecycle. Spawn a new task or replace an
        existing one (e.g. when watch_path changes)."""
        if not trigger.id:
            _log.warning("Cannot register watch for trigger without id")
            return
        # Cancel + replace if a task already exists for this id.
        existing = self._tasks.pop(trigger.id, None)
        if existing is not None:
            existing.cancel()
            try:
                await existing
            except (asyncio.CancelledError, Exception):
                pass
        self._spawn_task(trigger)

    async def on_trigger_deleted(self, trigger_id: str) -> None:
        """Called by the entity delete lifecycle. Cancel the task for this trigger."""
        task = self._tasks.pop(trigger_id, None)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    def _spawn_task(self, trigger: Trigger) -> None:
        if not trigger.id:
            return
        tid = trigger.id
        task = asyncio.create_task(_run_watch_for(trigger), name=f"FSOp:{tid}")
        task.add_done_callback(lambda _t, tid=tid: self._tasks.pop(tid, None))
        self._tasks[tid] = task


fsop_watcher = FSOpWatcher()
