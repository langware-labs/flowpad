"""Agent-family bus adapter (docs/flow-events.md phase 6) — the deletable
bridge emitting ``agent.status`` from the change-gated status-report seam.
Lean data; the full report rides the legacy watcher-scoped channel.

Also ``agent.no_token_source``: nothing can fund a process's harness (docs/flow-events.md)."""
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


NO_TOKEN_SOURCE = "agent.no_token_source"


def emit_no_token_source(process_id: str, worker_type: str, code: str, endpoint_typeid: str = "") -> None:
    """Nothing can fund this process's harness. ``code`` is the ``LLMSourceRefusal`` that names the
    fix (``budget_used``: the hub budget is spent); ``endpoint_typeid`` the source it is about.
    Best-effort — never fails the turn or the spawn that found out."""
    try:
        from flow_sdk.tags import emit_tag
        from flow_sdk.tags.envelope import target_of

        emit_tag(
            NO_TOKEN_SOURCE,
            target_of("agentic_process", process_id),
            {"worker_type": worker_type, "code": code, "endpoint_typeid": endpoint_typeid},
        )
    except Exception:
        logger.debug("%s emission failed", NO_TOKEN_SOURCE, exc_info=True)
