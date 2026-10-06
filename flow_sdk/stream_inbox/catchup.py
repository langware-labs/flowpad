"""Hub stream inbox catch-up — the one-shot ``conversation-list`` sweep.

The hub's WebSocket fan-out is LIVE-ONLY: ``Conversation._fanout_message``
pushes a frame to each participant's currently-open connections and drops it
for anyone who isn't connected. There is no offline queue and no replay on
(re)connect. So every transition from "no hub session" to "hub session" must
pull the backlog explicitly, or messages that landed while we were away stay
invisible until the user hits the stream inbox's manual refresh.

Two transitions qualify, and both call :func:`start_hub_catchup`:

* backend startup (``server.app``) — the app was closed while the hub kept
  accepting messages;
* cloud login (``cli.auth.cloud_login._finalize_login``) — the process was up
  but logged out, so the startup sweep bailed on ``hub_auth_available()`` and
  the hub had no connection to fan out to.

The transition has TWO halves and they are symmetric. Pulling the backlog is
what we missed while away; :func:`flush_pending_outbox` is what we still OWE:
every message composed here that the hub has not fully taken
(``FlowMessage.owes_delivery``) — typed while signed out (``pending_send``), a
push that failed while online, a body upload a restart cut short. Each is handed
to ``Conversation.deliver``, the one path a fresh send also takes, and each
attempt leaves its outcome on the message (SENT, or ``delivery_failure``).

The outbox is drained on every moment the hub may have become reachable:
backend startup, login, the WebSocket coming back
(``ws_client._catch_up_after_reconnect``), and the first hub call that succeeds
after one that could not reach it (``hub_http``'s reachability edge) — the case
where HTTP failed while the socket stayed up. This paragraph is the one place
that story is told; the outbox's other touchpoints (``Conversation.deliver``,
``handle_add_message``) point here rather than restating it.

A message queued into a conversation that was NEVER shared stays owed for good:
there is no hub row to push it to and no recipient waiting, and ``share()``
delivers it if the conversation is ever shared.
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
        logger.debug("[stream-inbox] catch-up (%s) skipped — no cloud session", reason)
        return
    local_user = await User.get_one({"uname": "local"})
    if not local_user:
        return
    # Outbox before backlog: a queued message is something the user already asked
    # to send, and pushing it first means the list we then fetch reflects it.
    await flush_pending_outbox(reason)

    # ``announce_invitations=True``: nobody asked for this call, so no client
    # refetch follows it. Without the announce, an invitation materialized here
    # lands in SQLite and stops there — invisible to an already-mounted stream inbox.
    resp = await handle_conversation_list(local_user.typeid, announce_invitations=True)
    dispatched = (getattr(resp, "data", None) or {}).get("bg_fetch_dispatched") or []
    logger.info(
        "[stream-inbox] catch-up (%s): queued message fetch for %d conversation(s)",
        reason,
        len(dispatched),
    )

    # Teams have the same live-only hole: one created while we were away never
    # reaches the share pickers, which read local rows only.
    from flow_sdk.app.actions.membership_sync import sync_remote_teams  # noqa: PLC0415

    teams = await sync_remote_teams(local_user.typeid)
    logger.info("[stream-inbox] catch-up (%s): mirrored %d team(s)", reason, teams)


async def flush_pending_outbox(reason: str) -> None:
    """Deliver everything this machine still owes the hub (see the module docstring).

    "Owed" is ``FlowMessage.owes_delivery`` — a message composed here that the hub has not
    accepted, or whose body it is still missing, however that happened: typed while signed out,
    a push that failed while online, an upload a restart cut short. Each owing conversation is
    handed to ``Conversation.deliver``, the same path a fresh send takes.

    Sequential on purpose: the common case is one conversation, and each writes rows. Best-effort
    per conversation — one unreachable thread must not strand the rest; whatever still fails
    stays owed, with its reason on the message, for the next transition.
    """
    from flow_sdk.cloud_client.transport.hub_http import outbox_draining  # noqa: PLC0415

    token = outbox_draining.set(True)
    try:
        await _flush(reason)
    finally:
        outbox_draining.reset(token)


async def _flush(reason: str) -> None:
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import BodyStatus, DeliveryStatus, FlowMessage  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    candidates: list = []
    for match in (
        {"delivery_status": DeliveryStatus.PENDING_SEND.value},
        {"outbound": True, "delivery_status": DeliveryStatus.CREATED.value},
        {"outbound": True, "body_status": BodyStatus.UPLOADING.value},
        {"outbound": True, "body_status": BodyStatus.FAILED.value},
    ):
        candidates.extend(await FlowMessage.get_all(QueryFilter(match=match), hydrate=False))
    conversation_ids = {fm.conversation_id for fm in candidates if fm.owes_delivery and fm.conversation_id}
    if not conversation_ids:
        return

    flushed = 0
    for conversation_id in conversation_ids:
        conversation = await Conversation.get_one({"id": conversation_id})
        if conversation is None or not conversation.hub_bound:
            continue
        try:
            await conversation.deliver()
            flushed += 1
        except Exception:  # noqa: BLE001
            logger.info(
                "[stream-inbox] outbox flush (%s) failed for conversation %s", reason, conversation_id, exc_info=True
            )
    logger.info(
        "[stream-inbox] outbox flush (%s): delivered %d of %d owing conversation(s)",
        reason,
        flushed,
        len(conversation_ids),
    )


def start_outbox_drain(reason: str) -> None:
    """``flush_pending_outbox`` off the caller's path (the hub-reachable edge fires inside a hub call)."""
    try:
        asyncio.get_running_loop().create_task(flush_pending_outbox(reason))
    except RuntimeError:  # no loop: a synchronous caller; the next transition drains instead
        pass


def start_hub_catchup(reason: str) -> None:
    """Fire-and-forget :func:`run_hub_catchup` — failure-isolated.

    Callers are transition sites (startup, login) that must not block on, or
    fail because of, a hub round-trip.
    """

    async def _run() -> None:
        try:
            await run_hub_catchup(reason)
        except Exception:  # noqa: BLE001
            logger.info("[stream-inbox] catch-up (%s) skipped", reason, exc_info=True)

    try:
        asyncio.get_running_loop().create_task(_run(), name=f"stream-inbox-catchup:{reason}")
    except RuntimeError:
        logger.debug("[stream-inbox] catch-up (%s) skipped — no running event loop", reason)
