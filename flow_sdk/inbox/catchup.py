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

The transition has TWO halves and they are symmetric. Pulling the backlog is
what we missed while away; :func:`flush_pending_outbox` is what we QUEUED while
away. A send composed with no cloud session is stored ``pending_send`` and not
pushed, and until this existed the only thing that ever flushed it was
``Conversation.share()`` creating the hub row — so a message typed into an
ALREADY-shared conversation had no moment to be sent in, and sat in the thread
looking sent, forever. Both halves belong to the same transition, so they run
in the same task. This paragraph is the one place that story is told; the
outbox's other touchpoints (``Conversation.deliver_pending_messages``,
``handle_add_message``) point here rather than restating it.

Two known edges, both currently benign, both worth knowing before adding a
third transition:

* A message queued into a conversation that was NEVER shared keeps
  ``pending_send`` for good. ``share_action`` stamps that status from
  ``is_logged_in()`` alone, without consulting ``remote``, so such a row exists
  — but there is no hub row to push it to and no recipient waiting, and
  ``share()`` flushes it if the conversation is ever shared. Nothing is lost;
  the status is simply pessimistic until then.
* ``cloud_client.ws_client._catch_up_after_reconnect`` is a THIRD resync hook
  and pulls only. It cannot strand anything today — ``pending_send`` requires
  being logged out, and losing credentials also drops the socket, so login's
  catch-up has already run by the time the WS is back — but if ``pending_send``
  is ever decoupled from ``is_logged_in()``, that hook needs this half too.
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
    # Outbox before backlog: a queued message is something the user already asked
    # to send, and pushing it first means the list we then fetch reflects it.
    await flush_pending_outbox(reason)

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


async def flush_pending_outbox(reason: str) -> None:
    """Push messages composed while there was no hub session (see module docstring).

    Reuses ``Conversation.deliver_pending_messages`` — the same send pipeline a
    normal reply takes — rather than a second push path that could drift from it.
    Only already-remote conversations are touched; a still-local one has no hub
    row to append to.

    Sequential on purpose. The common case is a single conversation, and the
    per-conversation work writes rows, so fanning out with ``gather`` would buy
    almost nothing and put concurrent writers on the SQLite connection.
    Best-effort per conversation: one unreachable thread must not strand the
    rest, and a message that fails to push stays local for the next transition.
    """
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    queued = await FlowMessage.get_all(
        QueryFilter(match={"delivery_status": DeliveryStatus.PENDING_SEND.value}),
        hydrate=False,
    )
    conversation_ids = {cid for fm in queued if (cid := getattr(fm, "conversation_id", ""))}
    if not conversation_ids:
        return

    flushed = 0
    for conversation_id in conversation_ids:
        conversation = await Conversation.get_one({"id": conversation_id})
        if conversation is None or not getattr(conversation, "remote", False):
            continue
        try:
            await conversation.deliver_pending_messages()
            flushed += 1
        except Exception:  # noqa: BLE001
            logger.info(
                "[inbox] outbox flush (%s) failed for conversation %s",
                reason,
                conversation_id,
                exc_info=True,
            )
    logger.info(
        "[inbox] outbox flush (%s): pushed queued messages for %d of %d conversation(s)",
        reason,
        flushed,
        len(conversation_ids),
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
