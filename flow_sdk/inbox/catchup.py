"""Hub inbox catch-up — the one-shot ``conversation-list`` sweep.

The hub's WebSocket fan-out is LIVE-ONLY: ``Conversation._fanout_message``
pushes a frame to each participant's currently-open connections and drops it
for anyone who isn't connected. There is no offline queue and no replay on
(re)connect. So every transition from "no hub session" to "hub session" must
pull the backlog explicitly, or messages that landed while we were away stay
invisible until the user hits the Inbox's manual refresh.

Two transitions qualify, and both call :func:`start_hub_catchup`:

* backend startup (``server.app``) — the app was closed while the hub kept
  accepting messages;
* cloud login (``cli.auth.cloud_login._finalize_login``) — the process was up
  but logged out, so the startup sweep bailed on ``hub_auth_available()`` and
  the hub had no connection to fan out to.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


async def run_hub_catchup(reason: str) -> None:
    """Pull the hub's conversation + invitation lists into the local store.

    Awaited form. No cloud session → returns immediately: every hub call would
    401 and only add noise to the warnings popover.
    """
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

    if not hub_auth_available():
        logger.debug("[inbox] catch-up (%s) skipped — no cloud session", reason)
        return
    local_user = await User.get_one({"uname": "local"})
    if not local_user:
        return
    # ``announce_invitations=True``: nobody asked for this call, so no client
    # refetch follows it. Without the announce, an invitation materialized here
    # lands in SQLite and stops there — invisible to an already-mounted Inbox.
    resp = await handle_conversation_list(local_user.typeid, announce_invitations=True)
    dispatched = (getattr(resp, "data", None) or {}).get("bg_fetch_dispatched") or []
    logger.info(
        "[inbox] catch-up (%s): queued message fetch for %d conversation(s)",
        reason,
        len(dispatched),
    )


def start_hub_catchup(reason: str) -> None:
    """Fire-and-forget :func:`run_hub_catchup` — failure-isolated.

    Callers are transition sites (startup, login) that must not block on, or
    fail because of, a hub round-trip.
    """

    async def _run() -> None:
        try:
            await run_hub_catchup(reason)
        except Exception:  # noqa: BLE001
            logger.info("[inbox] catch-up (%s) skipped", reason, exc_info=True)

    try:
        asyncio.get_running_loop().create_task(_run(), name=f"inbox-catchup:{reason}")
    except RuntimeError:
        logger.debug("[inbox] catch-up (%s) skipped — no running event loop", reason)
