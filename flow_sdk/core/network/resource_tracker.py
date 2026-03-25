"""Entity operation notification handler for minihub.

Sends websocket entity notifications for create/update/delete operations.
"""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi.encoders import jsonable_encoder

logger = logging.getLogger(__name__)


class DataOpMessage:
    """Entity operation message for WebSocket notifications."""

    _counter: int = 0

    def __init__(self, op: str, to_entity, data: Optional[dict] = None, message_id: Optional[str] = None):
        """
        Initialize DataOpMessage.

        Args:
            op: Operation type (create, update, delete)
            to_entity: TypeId or string in format "type-id" or "type:id"
            data: Optional entity data
            message_id: Optional message ID (will be generated if not provided)
        """
        DataOpMessage._counter += 1
        self.instance_id = DataOpMessage._counter
        self.message_type = "data_op_msg"
        self.message_id = message_id or str(uuid4())
        self.op = op
        # Handle TypeId or string
        if isinstance(to_entity, str):
            self.to_entity = to_entity
        else:
            # Assume it's a TypeId object
            self.to_entity = f"{to_entity.type}-{to_entity.id}"
        self.data = data

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        msg = {
            "message_type": self.message_type,
            "message_id": self.message_id,
            "instance_id": self.instance_id,
            "op": self.op,
            "to_entity": self.to_entity,
        }
        if self.data is not None:
            msg["data"] = self.data
        return msg


# UUID pattern (8-4-4-4-12 hex chars) at the end of a "type-uuid" string.
_UUID_SUFFIX_RE = re.compile(
    r"^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)


def _extract_entity_parts(to_entity: Any) -> tuple[str | None, str | None, str | None]:
    """Normalize to_entity into (type, id, type-id string)."""
    entity_type: str | None = None
    entity_id: str | None = None

    if isinstance(to_entity, str):
        if ":" in to_entity:
            entity_type, entity_id = to_entity.split(":", 1)
        elif "-" in to_entity:
            # TypeId serializes as "type-uuid". UUIDs contain hyphens, so rsplit("-", 1)
            # would incorrectly split inside the UUID. Use a UUID regex to find the
            # boundary, preserving hyphenated type names like "compute-node".
            m = _UUID_SUFFIX_RE.match(to_entity)
            if m:
                entity_type, entity_id = m.group(1), m.group(2)
            else:
                entity_type, entity_id = to_entity.rsplit("-", 1)
    elif isinstance(to_entity, dict):
        entity_type = to_entity.get("type")
        entity_id = to_entity.get("id")
    elif hasattr(to_entity, "type") and hasattr(to_entity, "id"):
        entity_type = getattr(to_entity, "type")
        entity_id = getattr(to_entity, "id")

    if not entity_type or not entity_id:
        return None, None, None

    type_id = f"{entity_type}-{entity_id}"
    return str(entity_type), str(entity_id), type_id


def _to_message_dict(op_message: Any) -> dict:
    """Serialize supported DataOpMessage variants to a plain JSON-safe dict."""
    if isinstance(op_message, dict):
        data = op_message
    elif hasattr(op_message, "model_dump"):
        data = op_message.model_dump()  # Pydantic models (api.messages.DataOpMessage)
    elif hasattr(op_message, "to_dict"):
        data = op_message.to_dict()  # Local compatibility wrapper
    else:
        raise TypeError(f"Unsupported op_message type: {type(op_message)}")

    if not isinstance(data, dict):
        raise TypeError(f"Serialized op_message is not a dict: {type(data)}")

    return jsonable_encoder(data, exclude_none=True)


def _resolve_recipients(
    op: str,
    entity_type: str | None,
    entity_id: str | None,
    active_connections: dict,
) -> set[str]:
    """Resolve recipient connection ids for a notification.

    For CREATE operations, broadcasts to all connections.
    For UPDATE/DELETE, sends to explicit watchers first.
    If no explicit watchers are found (common for webhook-originated
    operations with no user session), falls back to all local connections
    so the frontend still receives entity updates in desktop mode.
    """
    if op == "create" or not entity_type or not entity_id:
        return set(active_connections.keys())

    # UPDATE/DELETE should be sent to explicit watchers.
    from flow_sdk.app.actions.watch_registry import get_watched_by

    watched = get_watched_by(f"{entity_type}:{entity_id}")
    recipients = {conn_id for conn_id in watched if conn_id in active_connections}

    # Webhook fallback: when no explicit watchers exist (e.g. webhook endpoints
    # with no user session), broadcast to all local connections so the frontend
    # entity queries receive the update.  Safe in desktop mode (single user).
    if not recipients and op in ("update", "delete"):
        return set(active_connections.keys())

    return recipients


def _build_delete_flow_data_msg(type_id: str, entity_id: str) -> dict:
    """Build a flow_data_msg emitted before delete data_op."""
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "message_type": "flow_data_msg",
        "message_id": str(uuid4()),
        "to_entity": type_id,
        "flow_data": {
            "element_type": "notification",
            "data_type": "text",
            "attributes": {
                "event": "entity_deleted",
                "entity_id": entity_id,
                "t": timestamp,
            },
            "content": "",
        },
    }


async def _send_payloads(ws, payloads: list[dict]):
    for payload in payloads:
        await ws.send_text(json.dumps(payload))


def _sync_handle_entity_op(op_message: DataOpMessage):
    """
    Synchronous wrapper to handle entity operations and queue WebSocket notifications.

    This is called from the database layer (which may not have an event loop).
    It schedules notifications to be sent on the main event loop.
    """
    from flow_sdk.core.network.connections import get_all_connections

    try:
        # Get all active connections
        active_connections = get_all_connections()
        logger.debug(f"[notify] Active connections: {list(active_connections.keys())}")

        if not active_connections:
            logger.debug("No active connections, skipping notifications")
            return

        message = _to_message_dict(op_message)
        op = str(message.get("op", "")).lower()
        entity_type, entity_id, type_id = _extract_entity_parts(message.get("to_entity"))
        if type_id:
            message["to_entity"] = type_id

        recipients = _resolve_recipients(op, entity_type, entity_id, active_connections)
        if not recipients:
            logger.debug(f"No recipients for op={op}, entity={message.get('to_entity')}")
            return

        # Get the running event loop — this function is always called from an
        # async context (entity.save → handle_entity_op) so the loop is available.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("No running event loop, skipping notifications")
            return

        # DELETE should emit FlowData first, then DataOp delete.
        payloads: list[dict] = []
        if op == "delete" and type_id and entity_id:
            payloads.append(_build_delete_flow_data_msg(type_id, entity_id))
        payloads.append(message)

        # Send to resolved recipients
        sent_count = 0
        for conn_id in recipients:
            ws = active_connections.get(conn_id)
            if not ws:
                logger.warning(f"Connection {conn_id} websocket is None")
                continue

            try:
                logger.debug(f"[notify] Scheduling send to {conn_id}")
                loop.create_task(_send_payloads(ws, payloads))
                sent_count += 1
            except Exception as e:
                logger.error(f"Failed to notify {conn_id}: {e}")

        logger.debug(f"Dispatched {op} for {message.get('to_entity')} to {sent_count}/{len(recipients)} connections")

    except Exception as e:
        logger.error(f"Error handling entity op: {e}", exc_info=True)


async def handle_entity_op(op_message: DataOpMessage):
    """Async wrapper to handle entity operations and notify watchers."""
    _sync_handle_entity_op(op_message)


async def send_flow_data_to_entity(entity_typeid, flow_data: dict):
    """
    Send FlowData to all connections watching this entity.

    Args:
        entity_typeid: The TypeId of the entity (or string in "type-id" format)
        flow_data: Dictionary containing FlowData fields (element_type, content, attributes, etc.)
    """
    from flow_sdk.core.network.connections import get_all_connections

    try:
        entity_type, entity_id, type_id = _extract_entity_parts(entity_typeid)

        active_connections = get_all_connections()

        if not active_connections:
            return

        # Build the flow_data message
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        message = {
            "message_type": "flow_data_msg",
            "message_id": str(uuid4()),
            "to_entity": type_id,
            "flow_data": {
                **flow_data,
                "attributes": {
                    **(flow_data.get("attributes") or {}),
                    "t": timestamp,
                },
            },
        }

        # Send to all watchers of this entity
        from flow_sdk.app.actions.watch_registry import get_watched_by

        watched = get_watched_by(f"{entity_type}:{entity_id}")
        recipients = {conn_id for conn_id in watched if conn_id in active_connections}

        for conn_id in recipients:
            ws = active_connections.get(conn_id)
            if ws:
                try:
                    await ws.send_text(json.dumps(message))
                except Exception as e:
                    logger.error(f"Failed to send flow_data to {conn_id}: {e}")

    except Exception as e:
        logger.error(f"Error sending flow_data to entity: {e}", exc_info=True)


async def broadcast_progress(to_entity: str, flow_data: dict) -> None:
    """Send a flow_data_msg to ALL active connections (no watcher filter).

    Used for scan/index progress where the recipient is whoever is online,
    not a specific entity watcher.
    """
    from flow_sdk.core.network.connections import get_all_connections

    try:
        active_connections = get_all_connections()
        if not active_connections:
            return
        message = json.dumps({
            "message_type": "flow_data_msg",
            "message_id": str(uuid4()),
            "to_entity": to_entity,
            "flow_data": flow_data,
        })
        for ws in active_connections.values():
            try:
                await ws.send_text(message)
            except Exception:
                pass
    except Exception as e:
        logger.error(f"Error broadcasting progress: {e}", exc_info=True)
