"""``agent/<id>/setup_visitor_deployment`` — let signed-out visitors run an agent (FLOWPAD-2229).

The setup (the LLM endpoint each visitor's budget is drawn from, and the per-visitor cap) is a
field on the HUB's agent row, written only by the hub's own action: there is no local store for
it. The TS SDK (``Agent.setupVisitorDeployment``) sets ``ActionInfo.hub_reflect``, so the
dispatcher in ``graph.py`` forwards the call to the hub (see ``_hub_reflect``).

Registered so the local router resolves the name and can forward it at all: an action it does not
know is refused (``Unknown action``) before reflection is considered.

The local body runs only when the call was NOT reflected (an unpublished agent, offline, signed
out), so it fails loudly with 409 rather than fake-success.
"""

from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity

_OFFLINE_DETAIL = "Setting up visitor trials requires Flowpad Cloud and a published agent."


@action.post(action_name="setup_visitor_deployment", types=["agent"])
async def setup_visitor_deployment(self: Entity):
    """Store ``{llm_source, cap_usd}`` on the hub's agent row — hub-only."""
    raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)
