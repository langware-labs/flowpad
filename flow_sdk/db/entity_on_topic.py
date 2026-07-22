"""Entity-family bus adapter (docs/flow-events.md phase 3) — the deletable
bridge that dual-publishes every entity write as a standard FlowEvent.

Hooked at the ONE funnel every ``DataOpMessage`` flows through —
``DBEntity.add_entity_op_notification`` (all four mint sites call it, for
CREATE/UPDATE/DELETE alike). Legacy ``data_op_msg`` invalidation is untouched.

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
        to_entity = msg.to_entity
        if to_entity is None:
            return
        subtopic = _OP_TO_SUBTOPIC.get(str(msg.op or "").lower())
        if not subtopic:
            return
        from flow_sdk.topics import emit_topic
        from flow_sdk.topics.envelope import target_of

        from_entity = msg.from_entity
        emit_topic(
            f"entity.{subtopic}",
            target_of(to_entity.type, to_entity.id),
            {"entity_type": to_entity.type, "id": to_entity.id},
            ctx={"scope": [target_of(from_entity.type, from_entity.id)] if from_entity else []},
        )
    except Exception:
        logger.debug("entity.on_topic: emission failed", exc_info=True)
