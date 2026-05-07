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

import logging
import uuid
from typing import Any, Optional

from flow_sdk.cloud_client.ws_client import HubWebSocketManager, hub_ws_manager

logger = logging.getLogger(__name__)


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

    def install(self) -> None:
        """Register inbound handlers on the manager. Idempotent."""
        if self._installed:
            return
        self.manager.register_handler("data_op_msg", self._on_data_op)
        self._installed = True

    async def _on_data_op(self, message: dict) -> None:
        """Inbound data_op_msg dispatcher.

        Routes by the changed entity's type. Currently handles flow_message
        (create + update) and conversation (any op as a passive upsert).
        """
        op = str(message.get("op") or "").lower()
        etype, eid = _parse_to_entity(message.get("to_entity"))
        data = message.get("data")
        if not etype or not eid or not isinstance(data, dict):
            logger.debug("hub_bridge: ignoring data_op_msg with missing parts: %s", message)
            return

        try:
            if etype == "flow_message":
                await self._handle_flow_message_op(op, eid, data)
            elif etype == "conversation":
                await self._handle_conversation_op(op, eid, data)
            else:
                logger.debug("hub_bridge: no handler for data_op_msg type=%s op=%s", etype, op)
        except Exception:
            logger.exception("hub_bridge: error handling data_op_msg type=%s op=%s id=%s", etype, op, eid)

    async def _handle_flow_message_op(self, op: str, fm_id: str, data: dict) -> None:
        """CREATE → materialize locally + auto-ack delivery. UPDATE → status sync."""
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.user import User

        if op == "create":
            payload = dict(data)
            payload.setdefault("id", fm_id)
            conversation_id = payload.get("conversation_id")
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
                logger.warning("hub_bridge: flow_message create with no conversation_id, skipping: %s", fm_id)
                return

            local_user = await User.get_local()
            someone_typeid = local_user.typeid if local_user else None

            from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

            await materialize_flow_message(
                payload,
                conversation_id=conversation_id,
                someone_typeid=someone_typeid,
                notify=True,
            )

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
            for field in ("delivery_status", "delivered_at", "received_at", "is_read", "is_archived"):
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
        message_status_visible) so the local entity stays in sync."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None

        existing = await Conversation.get_one({"id": conv_id})
        if existing is None:
            if op == "delete":
                return
            payload = dict(data)
            payload.setdefault("id", conv_id)
            new_conv = Conversation.model_validate(payload)
            if not new_conv.id:
                new_conv.id = conv_id
            await new_conv.save(someone_typeid, notify=True)
            return

        if op == "delete":
            await Conversation.delete_by_id(conv_id)
            return

        for field in ("status", "title", "message_status_visible", "participants"):
            if field in data:
                setattr(existing, field, data[field])
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
