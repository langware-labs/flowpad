"""Artifact-family bus adapter — artifact lifecycle as standard FlowEvents.

``entity.created/updated/deleted`` already fires for artifacts like every other
row, but it cannot carry the one thing a consumer needs: **who produced this**.
That lives in ``Artifact.generated_by``, and putting it in ``ctx.scope`` is what
makes "this run's artifacts changed" addressable without every client watching
every artifact id.

Emitted from the artifact's own operations rather than the generic
``DataOpMessage`` funnel, because that funnel passes ``data=None`` on delete —
by the time it runs, the producer is exactly the field that is no longer
readable. The artifact knows its own producer; the funnel does not.

Lean by law: ``data`` carries identity and pointers, never the row. Subscribers
fetch what they need.

Unlike ``entity.*``, this family IS in the WS forward allowlist. It passes the
admission test because registration is explicit and agent-driven — bounded and
change-gated, not a per-write lane.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.artifact import Artifact

logger = logging.getLogger(__name__)

CREATED = "created"
UPDATED = "updated"
DELETED = "deleted"


def emit_artifact_tag(artifact: "Artifact", action: str) -> None:
    """Emit ``artifact.<action>`` for ``artifact``.

    Best-effort — an artifact write must never fail because the bus did.
    """
    try:
        from flow_sdk.api.api_types.type_id import TypeId
        from flow_sdk.tags import emit_tag
        from flow_sdk.tags.envelope import target_of

        producer = str(getattr(artifact, "generated_by", "") or "")
        # ``generated_by`` is a TypeId (``agentic_process-<uuid>``); the bus
        # grammar is colon-separated, so it is re-rendered rather than passed
        # through. A dash target here would silently never match a subscriber.
        scope: list[str] = []
        try:
            producer_typeid = TypeId(producer)
        except (ValueError, IndexError):
            pass
        else:
            if producer_typeid.id:
                scope.append(target_of(producer_typeid.type, str(producer_typeid.id)))

        emit_tag(
            f"artifact.{action}",
            target_of("artifact", str(artifact.id)),
            {
                "artifact_id": str(artifact.id),
                "generated_by": producer or None,
                "asset_ref": str(getattr(artifact, "asset_ref", "") or "") or None,
                "kind": str(getattr(artifact, "kind", "") or "") or None,
                "name": str(getattr(artifact, "name", "") or "") or None,
            },
            ctx={"scope": scope},
        )
    except Exception:
        logger.debug("artifact.on_tag: emission failed", exc_info=True)
