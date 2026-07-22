"""Agent-family bus adapter (docs/flow-events.md phase 6) — the deletable
bridge emitting ``agent.status`` from the change-gated status-report seam.
Lean data; the full report rides the legacy watcher-scoped channel."""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def emit_agent_status(process_id: str, worker_status: str,
                      process_status: str, busy: bool) -> None:
    """Best-effort — never fails the status tick that triggered it."""
    try:
        from flow_sdk.topics import emit_topic
        from flow_sdk.topics.envelope import target_of

        emit_topic(
            "agent.status",
            target_of("agentic_process", process_id),
            {"worker_status": worker_status, "process_status": process_status,
             "busy": busy},
        )
    except Exception:
        logger.debug("agent.status emission failed", exc_info=True)
