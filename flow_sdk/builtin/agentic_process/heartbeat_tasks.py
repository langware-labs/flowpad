"""System-heartbeat housekeeping tasks owned by the AgenticProcess module.

Loaded during ``load_entities()`` via the AP package ``__init__`` so each task's
``@register_heartbeat_task`` decorator runs before the heartbeat trigger first
fires. Tasks must be idempotent, bounded, and tolerant of double-fires.

There are currently no heartbeat tasks here. The former
``pending_user_to_inactive`` task existed only to re-broadcast the old
``PENDING_USER → INACTIVE`` *worker-status projection* after its 5-minute grace
window. That projection was removed in the status-model realignment: worker
status is now raw ("what we found"), and the logical process status
(``ready``/``busy``) is derived on every serialize, so nothing needs a timed
re-broadcast. Dead-PTY reconciliation is owned by the OS-liveness axis —
``server/pty_recovery.py`` (respawn watched dead PTYs) and
``AgenticProcess._on_pty_exit`` (stamp FAILED on an observed exit) — not by a
heartbeat. See ``docs/agent/agentic_process_statuses.md``.

Kept as an import target for the AP package ``__init__`` and as the home for any
future AP heartbeat task.
"""
from __future__ import annotations
