"""PTY recovery watchdog + the distinct ``recovered`` event.

A PTY worker is a child of the backend; on restart the previous process's
children die (SIGHUP) and the new process starts with an empty in-memory PTY
registry, leaving entities in a split-brain (``status=running`` + dead
``worker_pid``). This watchdog reconciles every visible session whose worker PID
is dead and respawns it through the existing ``AgenticProcess._perform_open``
path (drops the stale shell, relaunches with scrollback replay + resume — see
agentic_process.py).

It runs once at startup AND periodically (``start_recovery_task``) so a worker
that dies *mid-session* (e.g. a claude crash while the backend stays up) is also
respawned — this is the backend home for what used to be the frontend's
``os-status`` recovery poll. Connection membership (attach/detach on WS
connect/disconnect) is a separate, fully backend-owned FSM in
``pty_session_manager.PtyRegistry``; this module only handles a dead *worker*.

Recovered process ids are recorded for this backend lifetime. The watchdog
runs before any client has reconnected, so the distinct ``recovered`` event is
delivered when a client (re)watches a recovered process ("recovered AND a UI
is connected", per design) — the SDK then re-attaches its PTY stream.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

logger = logging.getLogger(__name__)

# Processes recovered during THIS backend lifetime. A client that watches one
# of these gets a ``recovered`` event (the watchdog itself runs before clients
# reconnect, so emission is gated on the (re)watch, not on recovery time).
_RECOVERED_IDS: set[str] = set()


def mark_recovered(process_id: str) -> None:
    _RECOVERED_IDS.add(process_id)


def was_recovered(process_id: str) -> bool:
    return process_id in _RECOVERED_IDS


def _recovered_message(process_id: str, shell_id: str | None, worker_pid: int | None) -> str:
    return json.dumps(
        {
            "message_type": "recovered_msg",
            "message_id": str(uuid4()),
            "to_entity": f"agentic_process-{process_id}",
            "process_id": process_id,
            "shell_id": shell_id,
            "worker_pid": worker_pid,
            "t": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    )


async def emit_recovered_to_connection(
    connection_id: str, process_id: str, shell_id: str | None, worker_pid: int | None
) -> None:
    from flow_sdk.core.network.connections import get_connection

    ws = get_connection(connection_id)
    if ws is None:
        return
    try:
        await ws.send_text(_recovered_message(process_id, shell_id, worker_pid))
    except Exception:
        logger.exception("pty-recovery: failed to send recovered_msg to %s", connection_id)


async def notify_watchers_recovered(
    process_id: str, shell_id: str | None, worker_pid: int | None
) -> None:
    """Push ``recovered`` to every connection currently watching the process
    (or its shell). Called both at recovery time (covers already-connected
    clients) and from the watch path (covers clients that connect later)."""
    from flow_sdk.app.actions.watch_registry import get_watched_by

    keys = [f"agentic_process:{process_id}"]
    if shell_id:
        keys.append(f"shell:{shell_id}")
    seen: set[str] = set()
    for key in keys:
        for conn_id in get_watched_by(key):
            if conn_id in seen:
                continue
            seen.add(conn_id)
            await emit_recovered_to_connection(conn_id, process_id, shell_id, worker_pid)


async def maybe_emit_recovered_on_watch(connection_id: str, entity_type: str, entity_id: str) -> None:
    """Watch-path hook: when a client watches a process that recovered this
    backend lifetime, deliver the ``recovered`` event to that connection.

    Also fires for a shell watch by resolving its owning process.
    """
    process_id: str | None = None
    if entity_type == "agentic_process":
        process_id = entity_id
    elif entity_type == "shell":
        from flow_sdk.builtin.agentic_process import AgenticProcess

        try:
            owner = await AgenticProcess.get_one({"shell_id": entity_id})
            process_id = owner.id if owner else None
        except Exception:
            process_id = None
    if not process_id or not was_recovered(process_id):
        return
    # The client matches the event on process_id and re-attaches via the full
    # onConnected handshake (it ignores worker_pid and only uses shell_id as a
    # secondary match key), so emit with just process_id — no extra entity reads.
    await emit_recovered_to_connection(connection_id, process_id, None, None)


async def reconcile_orphaned_workers() -> None:
    """Stamp dead headless (``visible=false``) RUNNING/STARTING workers to STOPPED.

    On restart the previous backend's child workers die (SIGHUP) and the new
    process starts with an empty in-memory PTY registry. ``run_pty_recovery``
    respawns the *visible* PTYs (with ``--resume``); a *headless* worker
    (``visible=false``, ``worker_pid``/``worker_status`` already gone) is not
    resumable in place, so its record would otherwise linger forever as a phantom
    "Background" agent in the footer chip (whose count keys on
    ``ProcessStatus ∈ {RUNNING, STARTING}``). The restart took the worker down —
    a clean stop, not a worker crash — so we stamp ``STOPPED`` (which is
    ``isProcessStartable``, letting the user relaunch).

    Pure DB writes — no subprocess spawn — so this is awaited at startup *before*
    serving, leaving the first bootstrap clean. ``save()`` emits the data_op, so
    already-connected clients also correct reactively. Visible PTYs are untouched
    here: they belong to ``run_pty_recovery`` (respawn) / ``_on_pty_exit``
    (FAILED), and stamping them at startup would race the respawn.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    live = (ProcessStatus.RUNNING.value, ProcessStatus.STARTING.value)
    try:
        procs = await AgenticProcess.get_all()
    except Exception:
        logger.exception("reconcile: failed to enumerate processes")
        return

    for proc in procs:
        try:
            if proc.visible:
                continue  # owned by run_pty_recovery (respawn) / _on_pty_exit
            if proc.status not in live:
                continue
            proc.status = ProcessStatus.STOPPED.value
            await proc.save()  # emits data_op → reactive correction in connected UIs
            logger.info("reconcile: stopped orphaned headless worker %s", proc.id)
        except Exception:
            logger.exception("reconcile: failed on %s", getattr(proc, "id", "?"))


async def run_pty_recovery() -> None:
    """Reconcile + respawn dead PTYs: agentic workers (with ``--resume``) and bare
    terminals (a fresh shell). Both kinds are ``Shell``-backed; the only divergence
    is the liveness signal and the respawn entry, handled per-pass below."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    try:
        procs = await AgenticProcess.get_all()
    except Exception:
        # Can't tell which shells are agentic-owned this tick — skip both passes
        # rather than risk bare-recovering a worker's shell (which would drop its
        # --resume session).
        logger.exception("pty-recovery: failed to enumerate processes")
        return

    for proc in procs:
        try:
            if not proc.visible:
                continue
            if proc.status not in (ProcessStatus.RUNNING.value, ProcessStatus.STARTING.value):
                continue
            if not proc.shell_id:
                continue
            shell = await proc.shell()
            alive = False
            if shell is not None:
                try:
                    alive = bool(await shell.has_attachable_pty() and await shell.worker_alive())
                except Exception:
                    alive = False
            if alive:
                continue  # genuinely survived (in-process reattach — rare)

            logger.info("pty-recovery: recovering %s (worker dead after restart)", proc.id)
            # Go through the LOCKED public entry (start_pty holds the per-process
            # _OPEN_LOCKS) — the SDK's own auto-recovery sweep calls open()
            # concurrently when the client re-watches, and two unserialized
            # _perform_open on one shell race (one drops the PTY the other just
            # created). start_pty → _perform_open emits the ``recovered`` event
            # from its shared recovery branch, so the event fires whether the
            # watchdog or the sweep wins the respawn (no double-emit here).
            from flow_sdk.responses.response import ApiFailResponse

            result = await proc.start_pty()
            if isinstance(result, ApiFailResponse):
                logger.warning("pty-recovery: %s open failed: %s", proc.id, result.message)
            else:
                logger.info("pty-recovery: recovered %s", proc.id)
        except Exception:
            logger.exception("pty-recovery: failed to recover %s", getattr(proc, "id", "?"))

    await _recover_bare_shells({p.shell_id for p in procs if p.shell_id})


# A bare terminal (no agentic worker) is just a Shell with worker_pid=None, so
# the agentic pass above (keyed on worker_alive) never touches it. Liveness for a
# bare shell is solely "is the PTY process attachable"; respawn is a fresh
# Shell.start_pty(). Bound to recently-active shells so a long-dead "running"
# record (an abandoned tab whose disk row was never closed) isn't resurrected on
# every restart — only a terminal the user plausibly still has open.
_BARE_SHELL_RECOVERY_WINDOW_SECONDS = 3600


async def _recover_bare_shells(agentic_shell_ids: set[str]) -> None:
    from datetime import datetime, timezone

    from flow_sdk.builtin.shell import Shell, ShellStatus

    try:
        shells = await Shell.get_all()
    except Exception:
        logger.exception("pty-recovery: failed to enumerate shells")
        return

    now = datetime.now(timezone.utc)
    for shell in shells:
        try:
            if shell.status != ShellStatus.RUNNING.value:
                continue
            # Agentic-owned shells are handled by the pass above (with --resume).
            if shell.id in agentic_shell_ids:
                continue
            # Recency gate — skip a long-dead "running" record; only revive a
            # terminal the user plausibly still has open. A missing/unparseable
            # last_active_at (ts is None) falls through and is treated as recent.
            ts = Shell._as_datetime(getattr(shell, "last_active_at", None))
            if ts and (now - ts).total_seconds() > _BARE_SHELL_RECOVERY_WINDOW_SECONDS:
                continue
            try:
                attachable = await shell.has_attachable_pty()
            except Exception:
                attachable = False
            if attachable:
                continue  # PTY survived in-process (rare) — nothing to do

            logger.info("pty-recovery: recovering bare shell %s (PTY dead after restart)", shell.id)
            await shell.start_pty()
            logger.info("pty-recovery: recovered bare shell %s", shell.id)
        except Exception:
            logger.exception(
                "pty-recovery: failed to recover bare shell %s", getattr(shell, "id", "?")
            )


# Background periodic watchdog (mid-session dead-worker respawn). Mirrors
# PtyRegistry.start_cleanup_task: a single cancellable loop. ``run_pty_recovery``
# is idempotent and re-entrant-safe (start_pty holds the per-process _OPEN_LOCKS),
# so a periodic sweep never double-spawns.
_recovery_task = None


async def start_recovery_task(interval_seconds: int = 5) -> None:
    """Run ``run_pty_recovery`` once now, then every ``interval_seconds``."""
    import asyncio

    global _recovery_task
    if _recovery_task is not None and not _recovery_task.done():
        logger.warning("pty-recovery: watchdog already running")
        return

    async def _loop() -> None:
        logger.info("pty-recovery: watchdog started (interval %ss)", interval_seconds)
        while True:
            try:
                await run_pty_recovery()
                await asyncio.sleep(interval_seconds)
            except asyncio.CancelledError:
                logger.info("pty-recovery: watchdog cancelled")
                break
            except Exception:
                logger.exception("pty-recovery: watchdog tick failed")
                await asyncio.sleep(interval_seconds)

    _recovery_task = asyncio.create_task(_loop(), name="pty-recovery")


async def stop_recovery_task() -> None:
    """Stop the periodic watchdog (best-effort)."""
    import asyncio

    global _recovery_task
    if _recovery_task is not None and not _recovery_task.done():
        _recovery_task.cancel()
        try:
            await _recovery_task
        except asyncio.CancelledError:
            pass
    _recovery_task = None
