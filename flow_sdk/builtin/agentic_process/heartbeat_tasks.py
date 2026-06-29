"""System-heartbeat housekeeping tasks owned by the AgenticProcess module.

Loaded during ``load_entities()`` via the AP package ``__init__`` so each
task's ``@register_heartbeat_task`` decorator runs before the heartbeat trigger
first fires.

Tasks must be idempotent, bounded (typical interactive load — small set
walks), and tolerant of double-fires.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.server.system_heartbeat import register_heartbeat_task

_log = logging.getLogger(__name__)


# 5-minute backend-owned grace window: AgenticProcesses whose worker hit a
# clean terminal status (COMPLETE/ERROR/INTERRUPTED) project to PENDING_USER
# for this long; after that the serializer projects them to INACTIVE.
_PENDING_USER_TTL_SECONDS = 300


@register_heartbeat_task("pending_user_to_inactive")
async def _pending_user_to_inactive() -> None:
    """Re-broadcast APs whose PendingUser grace window has expired so FE
    consumers see the projection flip to INACTIVE.

    Why we need a broadcast at all: the serializer's projection is
    deterministic (``terminal_at + 5min`` is the cutoff). Any consumer
    reading the AP would see INACTIVE automatically. But the FE caches the
    last-broadcast value and won't re-derive without a fresh entity update —
    so without the heartbeat nudge, the FE would show PENDING_USER until
    the next save/refresh.

    Important: we update ``_last_broadcast_status`` BEFORE notify_updated so
    the next heartbeat tick sees the AP at INACTIVE and skips it — otherwise
    we'd infinite-loop one broadcast per tick.
    """
    # Lazy import — this module loads at AP package init; AgenticProcess is
    # defined below the import-chain root.
    from flow_sdk.builtin.agentic_process import AgenticProcess

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_PENDING_USER_TTL_SECONDS)
    try:
        candidates = await AgenticProcess.get_all(
            entities_filter=QueryFilter(match=ExpressionNode(terminal_at__lt=cutoff))
        )
    except Exception:
        _log.debug("pending_user_to_inactive: candidate query failed", exc_info=True)
        return

    for ap in candidates:
        if getattr(ap, "_last_broadcast_status", None) != WorkerStatus.PENDING_USER:
            continue
        object.__setattr__(ap, "_last_broadcast_status", WorkerStatus.INACTIVE)
        try:
            await ap.notify_updated()
        except Exception:
            _log.debug(
                "pending_user_to_inactive: notify_updated failed for AP %s",
                ap.id, exc_info=True,
            )
