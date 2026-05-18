"""Bridge between the hub WS (HubWebSocketManager) and the local UI WS.

Wires inbound hub frames (data_op_msg for FlowMessage / Conversation) into
the local entity-save path so the existing local UI fan-out lights up
automatically. Outbound, exposes thin convenience methods for the realtime
conversation actions (start_guest_conversation, add_message, mark_received)
that callers route through the bridge instead of HTTP.

The hub side reaches participants by user id (notify_user_through_websocket),
so this bridge does NOT subscribe to entity watches on connect — membership
in Conversation.participants IS the subscription.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from flow_sdk.cloud_client.ws_client import HubWebSocketManager, hub_ws_manager

logger = logging.getLogger(__name__)


@dataclass
class _Subscription:
    """Internal record for ``HubWsBridge.subscribe()`` filters."""

    callback: Callable
    scope_id: Optional[str]
    entity_type: Optional[str]
    op: Optional[str]


def _parse_to_entity(to_entity: Any) -> tuple[Optional[str], Optional[str]]:
    """Normalize the to_entity field of a data_op_msg into (type, id)."""
    if isinstance(to_entity, str):
        if "-" in to_entity:
            etype, eid = to_entity.split("-", 1)
            return etype, eid
        if ":" in to_entity:
            etype, eid = to_entity.split(":", 1)
            return etype, eid
        return None, None
    if isinstance(to_entity, dict):
        return to_entity.get("type"), to_entity.get("id")
    if hasattr(to_entity, "type") and hasattr(to_entity, "id"):
        return to_entity.type, to_entity.id
    return None, None


class HubWsBridge:
    """Glue layer: hub WS frames ↔ local entity save path."""

    def __init__(self, manager: HubWebSocketManager = hub_ws_manager):
        self.manager = manager
        self._installed = False
        # Conversations the bridge has seen at least one hub event for —
        # used by the UI Reply path to decide whether to push outbound via
        # hub_ws_bridge.add_message() vs the local-only append path.
        self._hub_conv_ids: set[str] = set()
        # Generic subscribers — see ``subscribe()``. Used by
        # ``Entity.cloud_watch()`` to expose the hub event stream scoped to
        # any entity (its own UPDATEs + its children's CREATE/UPDATE/DELETE).
        self._subscriptions: list = []

    def install(self) -> None:
        """Register inbound handlers on the manager. Idempotent."""
        if self._installed:
            return
        self.manager.register_handler("data_op_msg", self._on_data_op)
        self._installed = True

    def is_hub_conversation(self, conversation_id: str) -> bool:
        """Whether this conversation has been seen on the hub WS — i.e., is
        mirrored from the hub and should round-trip outbound there."""
        return conversation_id in self._hub_conv_ids

    def remember_hub_conversation(self, conversation_id: str) -> None:
        if conversation_id:
            self._hub_conv_ids.add(conversation_id)

    def subscribe(
        self,
        callback,
        *,
        scope_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        op: Optional[str] = None,
    ):
        """Generic inbound subscription on the hub event stream.

        ``callback(event: EntityEvent)`` is invoked synchronously inside the
        bridge's inbound dispatcher for every hub ``data_op_msg`` that
        matches all the (optional) filters:

        - ``scope_id``    — match when the event's ``entity_id`` *or*
                            ``parent_id`` equals this id (covers "events
                            about me" + "events about my children").
        - ``entity_type`` — match when ``entity_type`` equals this string.
        - ``op``          — match when ``op`` equals this string
                            ("create"/"update"/"delete").

        Returns an unsubscribe callable. Safe to register from any task.
        """
        from flow_sdk.cloud_client.events import EntityEvent  # noqa: PLC0415

        sub = _Subscription(
            callback=callback,
            scope_id=scope_id,
            entity_type=entity_type,
            op=op,
        )
        self._subscriptions.append(sub)

        def _unsub() -> None:
            try:
                self._subscriptions.remove(sub)
            except ValueError:
                pass

        return _unsub

    def _dispatch_event(
        self,
        *,
        op: str,
        entity_type: str,
        entity_id: str,
        parent_type: Optional[str],
        parent_id: Optional[str],
        data: dict,
    ) -> None:
        """Fan a hub event to matching generic subscribers.

        Called from the inbound ``_on_data_op`` dispatcher AFTER any
        type-specific materialization, so subscribers observe the local
        store in its post-event state.
        """
        from flow_sdk.cloud_client.events import EntityEvent  # noqa: PLC0415

        if not self._subscriptions:
            return
        event = EntityEvent(
            op=op,
            entity_type=entity_type,
            entity_id=entity_id,
            parent_type=parent_type,
            parent_id=parent_id,
            data=data,
        )
        for sub in list(self._subscriptions):
            if sub.entity_type and sub.entity_type != entity_type:
                continue
            if sub.op and sub.op != op:
                continue
            if sub.scope_id and sub.scope_id not in (entity_id, parent_id):
                continue
            try:
                sub.callback(event)
            except Exception:
                logger.exception("hub_bridge: subscriber raised entity=%s/%s op=%s", entity_type, entity_id, op)

    async def _on_data_op(self, message: dict) -> None:
        """Inbound data_op_msg dispatcher.

        Routes by the changed entity's type. Currently handles flow_message
        (create + update) and conversation (any op as a passive upsert).
        """
        op = str(message.get("op") or "").lower()
        etype, eid = _parse_to_entity(message.get("to_entity"))
        # Parent envelope: hub sends a flow_message CREATE with from_entity =
        # the parent conversation. Used as the authoritative source for
        # conversation_id since the FlowMessage payload doesn't carry it.
        from_etype, from_eid = _parse_to_entity(message.get("from_entity"))
        data = message.get("data")
        if not etype or not eid or not isinstance(data, dict):
            logger.debug("hub_bridge: ignoring data_op_msg with missing parts: %s", message)
            return

        try:
            if etype == "flow_message":
                parent_conv_id = from_eid if from_etype == "conversation" else None
                await self._handle_flow_message_op(op, eid, data, parent_conv_id)
            elif etype == "conversation":
                await self._handle_conversation_op(op, eid, data)
            else:
                logger.debug("hub_bridge: no handler for data_op_msg type=%s op=%s", etype, op)
        except Exception:
            logger.exception("hub_bridge: error handling data_op_msg type=%s op=%s id=%s", etype, op, eid)

        # Generic fan-out to ``Entity.cloud_watch()`` subscribers — runs for
        # EVERY data_op_msg regardless of whether a type-specific handler
        # materialized it locally. Subscribers see entities the bridge does
        # not natively understand (rooms, devices, …) as plain events.
        # For flow_message CREATE the bridge resolved the conversation_id
        # via parents_path; pass it as parent_id so subscribers scoped to a
        # conversation receive child events even when the hub omitted
        # from_entity.
        resolved_parent_id = from_eid
        if etype == "flow_message" and not resolved_parent_id and isinstance(data, dict):
            resolved_parent_id = data.get("conversation_id")
        self._dispatch_event(
            op=op,
            entity_type=etype,
            entity_id=eid,
            parent_type=from_etype,
            parent_id=resolved_parent_id,
            data=data if isinstance(data, dict) else {},
        )

    async def _handle_flow_message_op(
        self,
        op: str,
        fm_id: str,
        data: dict,
        parent_conv_id: Optional[str] = None,
    ) -> None:
        """CREATE → materialize locally + auto-ack delivery. UPDATE → status sync."""
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.user import User

        if op == "create":
            payload = dict(data)
            payload.setdefault("id", fm_id)
            # Hub fires TWO create frames per add_message: the entity-save
            # auto-notify (no from_entity, broadcast to the sender and any
            # owners) and the explicit Conversation._fanout_message (with
            # from_entity, sent only to participants other than the sender).
            # The auto-notify version is useless to us — we already know
            # about our own sends — and lacks the conversation parent, so it
            # would hit the policy-denied parents_path fallback. Skip it by
            # matching ``sender_id`` against the *cloud* user id (the local
            # ``User`` row uses a different per-machine id).
            try:
                from flow_sdk.cli.app_config import get_user as _get_cloud_user
                cloud_user = _get_cloud_user() or {}
                cloud_user_id = cloud_user.get("id")
                if cloud_user_id and payload.get("sender_id") == cloud_user_id:
                    return
            except Exception:
                pass
            conversation_id = payload.get("conversation_id") or parent_conv_id
            if not conversation_id:
                # The hub may carry the conversation id under context_entities;
                # fall back when conversation_id isn't directly populated.
                ctx = payload.get("context") or payload.get("context_entities") or []
                for entry in ctx:
                    if isinstance(entry, dict) and entry.get("type") == "conversation":
                        conversation_id = entry.get("id")
                        break
                    if isinstance(entry, str) and entry.startswith("conversation-"):
                        conversation_id = entry.split("-", 1)[1]
                        break
            if not conversation_id:
                # Hub's fanout doesn't include a parent reference in the
                # FlowMessage data — fall back to a direct HTTP call to the
                # parents_path action, which walks the ownership chain
                # user→conversation→…→fm. WS-based send_request to
                # parents_path is not supported by the hub.
                try:
                    conversation_id = await self._fetch_conversation_id(fm_id)
                except Exception:
                    logger.exception("hub_bridge: parents_path HTTP lookup failed for fm=%s", fm_id)
            if not conversation_id:
                logger.warning(
                    "hub_bridge: flow_message create with no resolvable conversation_id, skipping fm=%s",
                    fm_id,
                )
                return

            self.remember_hub_conversation(conversation_id)

            local_user = await User.get_local()
            someone_typeid = local_user.typeid if local_user else None

            # CRITICAL PATH OPTIMIZATION
            # ─────────────────────────
            # Emit the FlowMessage CREATE op to local subscribers IMMEDIATELY
            # using the payload from the wire. ``conv.on('message', cb)`` taps
            # fire off this op — that's what unblocks alice's vitest loop on
            # every bob→alice message in the ping-pong e2e. The full
            # ``materialize_flow_message`` (DB save + conv.jsonl append +
            # conv message_ids/count projection + UI resource_sync × 2) does
            # ~300-500ms of work per call and used to sit on the critical
            # path between the hub fanout and the alice tap, blowing the
            # 6s ping-pong budget for STOP_AT=20.
            #
            # Now: TS subscribers see the data instantly via the in-payload
            # CREATE; persistence runs in the background and lands in the
            # local DB a few hundred ms later — well before the user's next
            # interaction needs to query the FM by id.
            try:
                from flow_sdk.api.messages import DataOpMessage, OperationType  # noqa: PLC0415
                from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415
                from flow_sdk.builtin.flow_message import FlowMessage as _FlowMessageCls  # noqa: PLC0415
                _fm_for_emit = _FlowMessageCls.model_validate(
                    {**payload, "conversation_id": conversation_id}
                )
                await handle_entity_op(
                    DataOpMessage(
                        data=_fm_for_emit,
                        op=OperationType.CREATE,
                        to_entity=_fm_for_emit.typeid,
                    )
                )
            except Exception as _emit_err:
                logger.warning("[bridge] inbound CREATE emit failed (non-fatal): %s", _emit_err)

            # Persist in the background — keeps the bridge handler off the
            # critical path. notify=False because we already emitted CREATE
            # above; a second notify would double-fire subscribers.
            async def _persist_inbound() -> None:
                try:
                    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
                    await materialize_flow_message(
                        payload,
                        conversation_id=conversation_id,
                        someone_typeid=someone_typeid,
                        notify=False,
                # Live hub arrival: emit the local CREATE even if a catch-up
                # sync already materialized the row, so the open conversation
                # ``on('message')`` listener still fires.
                emit_live_create=True,
            )except Exception as _err:
                    logger.warning("[bridge] inbound persist failed (non-fatal): %s", _err)

            asyncio.create_task(_persist_inbound())

            # Auto-ack delivery — receiver-side acks are the only signal that
            # makes the sender's UI tick from ✓ to ✓✓. Skip if the local user
            # IS the sender (hub ignores caller_is_sender anyway, but skipping
            # avoids the round-trip).
            if local_user and payload.get("sender_id") and payload["sender_id"] != local_user.id:
                self.manager.send({
                    "message_type": "rest_api_msg",
                    "message_id": str(uuid.uuid4()),
                    "method": "POST",
                    "scope": [],
                    "direct_resource_type": "flow_message",
                    "action": "mark_delivered",
                    "body": {"flow_message_ids": [fm_id]},
                })
            return

        if op == "update":
            existing = await FlowMessage.get_one({"id": fm_id})
            if existing is None:
                # Update before create — race or out-of-order delivery. Best
                # effort: upsert via materialize without conversation context
                # so the row exists for the UI to read.
                logger.debug("hub_bridge: update for unknown flow_message %s — skipping", fm_id)
                return
            local_user = await User.get_local()
            someone_typeid = local_user.typeid if local_user else None
            for field in (
                "delivery_status",
                "delivered_at",
                "received_at",
                "is_read",
                "is_archived",
                "body_status",
                "attachment_filename",
            ):
                if field in data:
                    setattr(existing, field, data[field])
            await existing.save(someone_typeid, notify=True)
            return

        if op == "delete":
            existing = await FlowMessage.get_one({"id": fm_id})
            if existing is not None:
                await FlowMessage.delete_by_id(fm_id)
            return

    async def _handle_conversation_op(self, op: str, conv_id: str, data: dict) -> None:
        """Passive upsert of Conversation lifecycle changes (status, participants,
        message_status_visible) so the local entity stays in sync.

        Drops projection-guarded fields (``message_count``, ``message_ids``)
        before save — those are owned by ``ConversationRecord.sync_to_db``."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None

        # Strip fields not on the local model or guarded against direct write.
        _PROJECTED = {"message_count", "message_ids"}
        _LOCAL_FIELDS = {
            "id", "type", "remote_project_id", "remote_project_name",
            "participants", "message_status_visible",
        }
        clean = {k: v for k, v in data.items() if k in _LOCAL_FIELDS and k not in _PROJECTED}
        clean["id"] = conv_id

        self.remember_hub_conversation(conv_id)

        existing = await Conversation.get_one({"id": conv_id})
        if existing is None:
            if op == "delete":
                return
            try:
                new_conv = Conversation.model_validate(clean)
            except Exception:
                logger.exception("hub_bridge: conversation validate failed conv=%s data=%s", conv_id, clean)
                return
            if not new_conv.id:
                new_conv.id = conv_id
            await new_conv.save(someone_typeid, notify=True)
            return

        if op == "delete":
            await Conversation.delete_by_id(conv_id)
            return

        for field in ("message_status_visible", "participants", "remote_project_id", "remote_project_name"):
            if field in clean:
                setattr(existing, field, clean[field])
        await existing.save(someone_typeid, notify=True)

    # ------------------------------------------------------------------
    # Outbound helpers — thin wrappers around send_request for callers that
    # want a clean coroutine API instead of building rest_api_msg payloads.
    # ------------------------------------------------------------------

    async def start_guest_conversation(
        self,
        *,
        project_id: str,
        text: str,
        receiver_id: Optional[str] = None,
        message_status_visible: bool = True,
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if receiver_id:
            body["receiver_address"] = receiver_id
            body["receiver_address_type"] = "id"
        if not message_status_visible:
            body["message_status_visible"] = False
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "project", "id": project_id},
                "action": "start_guest_conversation",
                "body": body,
            },
            timeout=timeout,
        )

    async def add_message(
        self,
        *,
        conversation_id: str,
        text: str,
        sender_name: Optional[str] = None,
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if sender_name:
            body["sender_name"] = sender_name
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "conversation", "id": conversation_id},
                "action": "add_message",
                "body": body,
            },
            timeout=timeout,
        )

    async def _fetch_conversation_id(self, fm_id: str) -> Optional[str]:
        """Walk the ownership chain via HTTP /flow_message/<id>/parents_path
        and return the conversation entry, or None."""
        import httpx
        from flow_sdk.cli.auth.credentials import load_credentials
        from flow_sdk.cloud_client.client import ApiConfig

        creds = load_credentials()
        if not creds or not creds.api_key:
            return None
        api = ApiConfig.from_env()
        url = api._get_full_url(f"/graph/flow_message/{fm_id}/parents_path")
        headers = {"Authorization": f"Bearer {creds.api_key}", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            body = r.json()
            chain = (body or {}).get("data") or []
            for ent in chain:
                if isinstance(ent, dict) and ent.get("type") == "conversation":
                    return ent.get("id")
        return None

    async def mark_received(self, *, flow_message_ids: list[str], timeout: float = 5.0) -> dict:
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "direct_resource_type": "flow_message",
                "action": "mark_received",
                "body": {"flow_message_ids": list(flow_message_ids)},
            },
            timeout=timeout,
        )


hub_ws_bridge = HubWsBridge()
