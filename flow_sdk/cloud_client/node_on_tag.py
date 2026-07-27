"""Node-family bus adapter (docs/flow-events.md phase 6) — the deletable
bridge emitting ``node.<transition>`` from the connection-status funnel.

Targets THE local compute node via its DETERMINISTIC id
(``ComputeNode._local_id()`` — pure, no DB read, no mint side-effect): a
liveness observer must never create rows or pay a query per reconnect flap.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def emit_node_transition(transition: str, error: Optional[str] = None) -> None:
    """Best-effort — never fails the connection transition that triggered it."""
    try:
        from flow_sdk.builtin.compute_node import ComputeNode
        from flow_sdk.tags import emit_tag
        from flow_sdk.tags.envelope import target_of

        emit_tag(
            f"node.{transition.lower()}",
            target_of("compute_node", ComputeNode._local_id()),
            {"error": error} if error else {},
        )
    except Exception:
        logger.debug("node liveness emission failed", exc_info=True)
