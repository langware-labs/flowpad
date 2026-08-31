"""FSOpWatcher — runtime for FSOp triggers.

Owns one asyncio.Task per FSOp trigger running `watchfiles.awatch`; translates
file events into `_fire(...)` which does in-memory bookkeeping + action dispatch.

Each awatch yield is a debounce window (configured per-trigger via step_ms /
debounce_ms). `_fire` is called once per yield with the full batch as a
`list[ChangeEvent]` — one DB write, one log row, one callback invocation per
window. Filter composition (default + trigger-config ignores + .gitignore) lives
in `fsop_filters.CompositeFsopFilter`.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.trigger import Trigger, TriggerType

_log = logging.getLogger(__name__)

# Cap path count persisted per log row so a 50k-event burst doesn't bloat the
# trigger log JSONL. `changes_total` still reflects the real count.
_LOG_CAP = 50


async def _fire(
    trigger: Trigger,
    changes: list[ChangeEvent],
    *,
    is_test: bool = False,
) -> None:
    """Apply a debounce-batch of file-change events to a trigger.

    One fire == one debounce window. ``changes`` is the full batch; the
    counter increments by ``len(changes)`` (real fires count per-event, not
    per-window — keeps the existing metric semantics).

    ``is_test=True`` is passed by ``Trigger.test_action``. Actions still run
    for real — same precedent as schedule's test path — but the log entry is
    marked ``is_test=True`` and its ``event_kind`` becomes ``"test"`` so the
    invocations panel can render it distinctly from organic file events. Test
    fires must not mutate counter / last_triggered / last_seen_* — those are
    the "real fires" surfaces in the UI list/detail and the catch-up anchor.
    """
    if not trigger.enabled or not changes:
        return

    if not is_test:
        trigger.counter += len(changes)
        trigger.last_triggered = datetime.now(timezone.utc)
        # last_seen_* anchors catch-up replay on next boot. Update from the
        # MOST RECENT change matching watch_path (if any) — a synthetic test
        # would otherwise settle the fingerprint and mask organic changes.
        if trigger.watch_path:
            for c in reversed(changes):
                if str(c.path) == trigger.watch_path:
                    try:
                        st = c.path.stat()
                        trigger.last_seen_mtime = st.st_mtime
                        trigger.last_seen_size = st.st_size
                    except FileNotFoundError:
                        trigger.last_seen_mtime = None
                        trigger.last_seen_size = None
                    break

    # Persist counter/last_triggered/last_seen_* so the UI reflects the fire.
    if trigger.id and not is_test:
        try:
            await trigger.update()
        except Exception:
            _log.exception("Trigger %s: failed to persist counter/last_triggered", trigger.name)

    # Shared fire steps — the SAME helpers schedule and tag fires use. These
    # were inlined copies until the bus emitters landed and made a third
    # duplicated concern obvious; the fire contract (the `envelope=` kwarg,
    # `trigger.failed` emission) now has one home instead of three.
    from flow_sdk.builtin.trigger import activate_flows_for_trigger, dispatch_trigger_actions

    if not is_test and trigger.id:
        await activate_flows_for_trigger(trigger.id, trigger.name or trigger.id,
                                         trigger=trigger)
    await dispatch_trigger_actions(trigger, changes=changes)

    # One log row per fire. Cap paths persisted; `changes_total` is the truth.
    first = changes[0]
    sampled = [{"path": str(c.path), "change_type": c.change_type} for c in changes[:_LOG_CAP]]

    # ONE envelope per fire — i.e. per debounce window, matching the log row.
    # Never move this into the raw-changes loop in `_run_watch_for` and never
    # into the watch_filter: awatch's debounce IS the rate guard here, and a
    # per-file emission would be exactly the per-write lane that keeps
    # `entity.*` off the forwarding allowlist. `detail` carries counts and the
    # first path only; the batch itself belongs to the log row above.
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired

    event_id = emit_trigger_fired(
        trigger.id or "", str(trigger.trigger_type), trigger.name or trigger.id or "",
        counter=trigger.counter,
        action_types=[str(a.action_type) for a in trigger.actions],
        detail={
            "changes_total": len(changes),
            "first_path": str(first.path),
            "first_change_type": first.change_type,
        },
        project_id=trigger.project_id,
        is_test=is_test,
    )

    try:
        from flow_sdk.fs_store.operations.trigger_log import append_entry as _append_trigger_log_entry

        _append_trigger_log_entry(
            trigger.name,
            {
                # Legacy fields — keep populated from the first event so old
                # log readers (TriggerLogViewer lens, hook-shape invocation
                # rows) continue rendering before the UI consumes the new
                # batch fields.
                "hook_event": "file_change",
                "reason": (
                    f"File {first.change_type}: {first.path}"
                    if len(changes) == 1
                    else f"{len(changes)} file events; first: {first.change_type}: {first.path}"
                ),
                # Structured fields.
                "event_kind": "test" if is_test else "file_change",
                "changed_path": str(first.path),
                "change_type": first.change_type,
                # Batch fields — new in this refactor.
                "changes": sampled,
                "changes_total": len(changes),
                "changes_truncated": max(0, len(changes) - _LOG_CAP),
                "trigger": True,
                "is_test": is_test,
                "rule_name": trigger.name,
                "trigger_id": trigger.id,
                "trigger_type": str(trigger.trigger_type),
                "event_id": event_id,
                "actor": "system",
                "actions": [{"action_type": str(a.action_type)} for a in trigger.actions],
                "agentic_process_id": None,
            },
        )
    except Exception:
        _log.exception("Trigger %s: failed to append trigger_log entry", trigger.name)


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
        await _fire(trigger, [ChangeEvent(path=path, change_type="deleted")])
        return
    if exists and not had_seen:
        await _fire(trigger, [ChangeEvent(path=path, change_type="added")])
        return

    # Both endpoints have the file — compare fingerprints.
    st = path.stat()
    if st.st_mtime != trigger.last_seen_mtime or st.st_size != trigger.last_seen_size:
        await _fire(trigger, [ChangeEvent(path=path, change_type="modified")])


# ── per-trigger awatch loop ───────────────────────────────────────────────────


async def _run_watch_for(trigger: Trigger) -> None:
    """Per-trigger awatch loop. File-mode watches the parent dir + exact-path
    filter (survives atomic-rename inode swaps); folder-mode watches the dir.
    One `_fire` per debounce window — the full batch is passed downstream.
    Exits cleanly on CancelledError.
    """
    from watchfiles import awatch

    from flow_sdk.server.fsop_filters import CompositeFsopFilter

    if not trigger.watch_path:
        _log.warning("Trigger %s has no watch_path; nothing to watch", trigger.name)
        return

    watched_path = Path(trigger.watch_path)
    is_folder = watched_path.is_dir() or trigger.recursive
    watch_dir = watched_path if is_folder else watched_path.parent
    if not watch_dir.exists():
        _log.warning("Trigger %s: watch dir %s does not exist; skipping", trigger.name, watch_dir)
        return

    composite_filter = CompositeFsopFilter(trigger=trigger, watched_path=watched_path)

    # pending improvement: macOS FSEvents missed-event recovery for newly-
    # created subdirectories. https://lwn.net/Articles/605128/
    # pending improvement: Windows ReadDirectoryChangesW 64KB buffer / overflow.
    # https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw

    try:
        async for raw_changes in awatch(
            str(watch_dir),
            recursive=trigger.recursive,
            watch_filter=composite_filter,
            step=trigger.step_ms,
            debounce=trigger.debounce_ms,
        ):
            batch: list[ChangeEvent] = []
            for change_type, raw_path in raw_changes:
                # NB: don't .resolve() here — last_seen_* matching in _fire and
                # transcript_streamer_registry's path-keyed dict both compare
                # against the unresolved watch path. Resolving would silently
                # split-brain on platforms where /tmp -> /private/tmp.
                change_name = getattr(change_type, "name", None) or str(change_type)
                batch.append(ChangeEvent(path=Path(raw_path), change_type=change_name))

            if not batch:
                continue
            try:
                await _fire(trigger, batch)
            except Exception:
                _log.exception(
                    "Trigger %s: _fire raised for %d-event batch", trigger.name, len(batch)
                )

        # pending improvement: inotify queue overflow recovery on Linux —
        # detect IN_Q_OVERFLOW, cancel + rescan tree + respawn.
        # https://github.com/tilt-dev/tilt/issues/1772
        # pending improvement: awaitWriteFinish-style stability check for
        # large writes (avoid firing on partial state).
        # https://github.com/paulmillr/chokidar#path-filtering
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

    async def rearm(self) -> None:
        """Spawn one watch task per FSOp trigger, WITHOUT `start()`'s catch-up.

        For the factory-reset path only. A reset stops the watcher (it must —
        stale pre-wipe entities collide on `uname`) and then re-seeds the rows,
        so without this the FSOp triggers come back stored but unwatched. It
        deliberately skips `_catch_up_if_changed`: that per-trigger disk walk is
        what makes `start()` too slow for a path that runs on every `resetDb()`,
        and a just-wiped-and-re-seeded row has no missed-change window anyway.
        """
        for trigger in await Trigger.list_by_type(TriggerType.FSOP):
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
