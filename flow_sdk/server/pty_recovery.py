"""PTY recovery watchdog + the distinct ``recovered`` event.

A PTY worker is a child of the backend; on restart the previous process's
children die (SIGHUP) and the new process starts with an empty in-memory PTY
registry, leaving entities in a split-brain (``status=running`` + dead
``worker_pid``). This watchdog runs once at startup, reconciles every visible
session whose worker PID is dead, and respawns it through the existing
``AgenticProcess._perform_open`` path (drops the stale shell, relaunches with
scrollback replay + resume — see agentic_process.py).

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


async def run_pty_recovery() -> None:
    """Reconcile + respawn every visible session with a dead worker."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    try:
        procs = await AgenticProcess.get_all()
    except Exception:
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
