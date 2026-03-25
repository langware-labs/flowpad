"""Webhook route for receiving hook events from CLI agents.

Ported from FlowPad: flowpad/hub/routers/webhook.py
Provides the /api/v1/webhook/listen endpoint for CLI-to-server communication.
"""

from fastapi import APIRouter, Request

webhook_router = APIRouter(prefix="/api/v1/webhook")


@webhook_router.post("/listen")
async def listen_endpoint(request: Request):
    """
    Public endpoint for receiving hook events from CLI.

    URL pattern: POST /api/v1/webhook/listen
    """
    from flow_sdk.app.actions.listen import listen_action

    return await listen_action(request)
