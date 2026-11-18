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
        from flow_sdk.tags import emit_tag
        from flow_sdk.tags.envelope import target_of

        emit_tag(
            "agent.status",
            target_of("agentic_process", process_id),
            {"worker_status": worker_status, "process_status": process_status,
             "busy": busy},
        )
    except Exception:
        logger.debug("agent.status emission failed", exc_info=True)


def emit_agent_turn_ended(process_id: str, worker_status: str) -> None:
    """``agent.turn_ended`` — once per turn, on the busy → idle edge. ``agent.status`` fires on
    every report change, many times a turn; a rule that wants "after each turn" listens here."""
    try:
        from flow_sdk.tags import emit_tag
        from flow_sdk.tags.envelope import target_of

        emit_tag("agent.turn_ended", target_of("agentic_process", process_id), {"worker_status": worker_status})
    except Exception:
        logger.debug("agent.turn_ended emission failed", exc_info=True)
