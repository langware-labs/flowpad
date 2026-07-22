"""Hub-family bus adapter (docs/flow-events.md phase 6) — the deletable
bridge relaying inbound hub entity events under their OWN family
(``hub.entity.<op>``, never ``entity.*``) until phase-9 scope authorization,
with ``origin: "hub"`` and the actor preserved.

Actor rides through UNNORMALIZED: the hub sends it pre-formatted in target
form (``user:<id>``); phase-9 authorization is where validation lands.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def emit_hub_entity(op: str, entity_type: str, entity_id: str,
                    parent_type: Optional[str], parent_id: Optional[str],
                    actor: Optional[str]) -> None:
    """Best-effort — never fails the inbound dispatch that triggered it."""
    try:
        from flow_sdk.topics import emit_topic
        from flow_sdk.topics.envelope import target_of

        emit_topic(
            f"hub.entity.{op}",
            target_of(entity_type, entity_id),
            {"entity_type": entity_type, "id": entity_id,
             "parent_type": parent_type, "parent_id": parent_id},
            ctx={"origin": "hub", "actor": actor or None},
        )
    except Exception:
        logger.debug("hub.entity relay emission failed", exc_info=True)
