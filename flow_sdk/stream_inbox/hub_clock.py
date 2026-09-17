"""Birth-time reconciliation for the two hub-mirrored inbox types.

``Conversation`` and ``FlowMessage`` are the only entities whose rows mirror a hub
counterpart closely enough that the hub owns their birth time. Everything else is
born locally, so this policy would be dead weight on the base ``Entity`` — hence
plain functions here rather than methods someone might reach for by accident.

The rule they encode is small but easy to get wrong, and getting it wrong is what
produced the inbox-reshuffle bug: a locally re-created row is stamped ``now()``,
which makes it look NEWER than the hub, so any repair placed behind a staleness
check is unreachable and the wrong value defends itself. Both callers must
therefore consult these SEPARATELY from ``is_stale`` — never behind it.
"""

from __future__ import annotations

from typing import Any, Optional


def _as_datetime(value: Any):
    """Coerce a stored/serialized timestamp for comparison.

    Delegates to the entity layer's own coercion so this module can never drift
    from how the rest of the codebase reads a timestamp.
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    return Entity._as_datetime(value)


def hub_created_drift(local: Optional[Any], hub_payload: dict) -> bool:
    """``True`` when the hub's birth time differs from the local row's.

    Deliberately NOT part of ``is_stale``: ``created_date`` is hub-authoritative
    and corruptible locally — a re-materialize stamps it with ``now()`` without
    ever moving ``updated_date`` — so a drifted row looks *newer* than the hub and
    ``is_stale`` returns False. Gating the repair on staleness therefore lets the
    wrong value defend itself.
    """
    hub_created = _as_datetime(hub_payload.get("created_date"))
    return (
        local is not None
        and hub_created is not None
        and _as_datetime(getattr(local, "created_date", None)) != hub_created
    )


def adopt_hub_created_date(local: Optional[Any], hub_payload: dict) -> bool:
    """Adopt the hub's ``created_date`` onto ``local``; ``True`` if it changed.

    Idempotent — once converged, later echoes are no-ops — so it is safe on every
    sync pass. The hub is authoritative for birth time, which also keeps every
    participant sorting by the same clock.
    """
    if not hub_created_drift(local, hub_payload):
        return False
    local.created_date = _as_datetime(hub_payload.get("created_date"))
    return True
