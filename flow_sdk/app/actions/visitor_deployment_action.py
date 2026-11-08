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


_PUBLIC_OFFLINE_DETAIL = "Public deployments require Flowpad Cloud and a published agent."


@action.post(action_name="enable_public_deployments", types=["agent"])
async def enable_public_deployments(self: Entity):
    """Turn on public deployments on the hub's agent row — hub-only, forwarded by ``hub_reflect``."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


@action.post(action_name="disable_public_deployments", types=["agent"])
async def disable_public_deployments(self: Entity):
    """Turn off public deployments — hub-only."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


@action.get(action_name="public_deployments", types=["agent"])
async def public_deployments(self: Entity):
    """The public-deployment settings, invite codes and boxes — hub-only."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


@action.post(action_name="add_public_codes", types=["agent"])
async def add_public_codes(self: Entity):
    """Mint invite codes — hub-only."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


@action.post(action_name="revoke_public_code", types=["agent"])
async def revoke_public_code(self: Entity):
    """Revoke one invite code — hub-only."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


@action.post(action_name="manage_public_deployment", types=["agent"])
async def manage_public_deployment(self: Entity):
    """Open, pause, resume or reset one visitor box — hub-only."""
    raise HTTPException(status_code=409, detail=_PUBLIC_OFFLINE_DETAIL)


_IT_OFFLINE_DETAIL = "IT messages require Flowpad Cloud and a published agent."


@action.post(action_name="it_message", types=["agent"])
async def it_message(self: Entity):
    """Send an IT message to this agent's public machines — hub-only (the hub runs it on each box)."""
    raise HTTPException(status_code=409, detail=_IT_OFFLINE_DETAIL)


@action.post(action_name="it_sessions", types=["agent"])
async def it_sessions(self: Entity):
    """Turn IT Sessions on or off on this agent's public machines — hub-only."""
    raise HTTPException(status_code=409, detail=_IT_OFFLINE_DETAIL)
