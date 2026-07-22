"""Entity-family bus adapter (docs/flow-events.md phase 3) — the deletable
bridge that dual-publishes every entity write as a standard FlowEvent.

Hooked at the TWO funnels every ``DataOpMessage`` flows through
(``DBEntity._notify_observers`` for CREATE/UPDATE, ``add_entity_op_notification``
for DELETE). Legacy ``data_op_msg`` invalidation is untouched.

Lean on purpose: ``data`` carries ``{entity_type, id}`` only — never the
serialized row. Law 5 (event ≠ proof) means subscribers fetch what they need;
the hot path stays ~free (zero-subscriber fast path skips even the envelope),
and no payload values can ever reach a future recorder from here.

Cycle note: a subscriber that WRITES entities re-triggers ``entity.updated``.
Subscribers must be idempotent and never unconditionally write their own
trigger entity; the systemic storm guard arrives with phase 4's trigger
machinery.

``entity.*`` is deliberately NOT in the WS forward allowlist — the app keeps
``data_op_msg`` until a frontend consumer wants the topic form (phase 8).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.api.api_types.messages import DataOpMessage

logger = logging.getLogger(__name__)

_OP_TO_SUBTOPIC = {
    "create": "created",
    "update": "updated",
    "delete": "deleted",
}


def emit_entity_topic(msg: "DataOpMessage") -> None:
    """Map one DataOpMessage onto ``entity.created/updated/deleted``.
    Best-effort — never fails the write that triggered it."""
    try:
        to_entity = getattr(msg, "to_entity", None)
        if to_entity is None:
            return
        subtopic = _OP_TO_SUBTOPIC.get(str(getattr(msg, "op", "") or "").lower())
        if not subtopic:
            return
        from flow_sdk.topics import emit_topic

        from_entity = getattr(msg, "from_entity", None)
        emit_topic(
            f"entity.{subtopic}",
            f"{to_entity.type}:{to_entity.id}",
            {"entity_type": to_entity.type, "id": to_entity.id},
            ctx={"scope": [f"{from_entity.type}:{from_entity.id}"] if from_entity else []},
        )
    except Exception:
        logger.debug("entity.on_topic: emission failed", exc_info=True)
