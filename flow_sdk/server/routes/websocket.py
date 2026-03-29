"""WebSocket router for minihub.

Handles WebSocket connections and message routing following the original FlowPad pattern.
"""

import contextvars
import json
import logging
from typing import Dict
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from flow_sdk.core.network.connection_manager import set_external_connection_lookup
from flow_sdk.core.network.connections import (
    add_connection as add_registry_connection,
)
from flow_sdk.core.network.connections import (
    remove_connection as remove_registry_connection,
)

from .ws_rest import handle_rest_message

websocket_router = APIRouter()

# Store active connections
_active_connections: Dict[str, WebSocket] = {}


class MinihubConnectionHandler:
    """Wrapper to make minihub WebSocket connections compatible with SDK's ConnectionHandler interface."""

    def __init__(self, websocket: WebSocket):
        self.websocket = websocket

    async def send_message(self, message):
        import json

        if isinstance(message, dict):
            message = json.dumps(message)
        await self.websocket.send_text(message)


def _minihub_connection_lookup(connection_id: str):
    """Lookup a connection by ID and return a ConnectionHandler-compatible wrapper."""
    ws = _active_connections.get(connection_id)
    if ws:
        return MinihubConnectionHandler(ws)
    return None


# Register minihub's connection lookup with the SDK
set_external_connection_lookup(_minihub_connection_lookup)

logger = logging.getLogger(__name__)


def get_active_connections() -> Dict[str, WebSocket]:
    """Get dict of all active connections."""
    return _active_connections


async def send_personal_message(message: str, websocket: WebSocket):
    """Send a message to a specific WebSocket connection."""
    try:
        await websocket.send_text(message)
    except Exception as e:
        logger.error(f"Error sending personal message: {e}")


async def broadcast(message: str):
    """Broadcast a message to all connected clients."""
    if not _active_connections:
        return

    disconnected = []
    for connection_id, websocket in _active_connections.items():
        try:
            await websocket.send_text(message)
        except Exception as e:
            logger.error(f"Error broadcasting to {connection_id}: {e}")
            disconnected.append(connection_id)

    # Clean up disconnected clients
    for connection_id in disconnected:
        _active_connections.pop(connection_id, None)
        remove_registry_connection(connection_id)


async def send_entity_notification(entity_type: str, entity_id: str, op: str, entity_data: dict = None):
    """
    Send entity change notification.

    For CREATE: broadcasts to all connected clients
    For UPDATE/DELETE: sends only to explicit watchers

    Args:
        entity_type: Entity type (project, user, etc.)
        entity_id: Entity ID
        op: Operation type (create, update, delete)
        entity_data: Entity data dict (for create/update)
    """
    try:
        from flow_sdk.app.actions.watch_registry import get_watched_by

        entity_key = f"{entity_type}:{entity_id}"
        logger.debug(f"Entity notification: {entity_key}, op={op}")

        # Build notification message with TypeId format for to_entity
        message = {
            "message_type": "data_op_msg",
            "message_id": str(uuid4()),
            "to_entity": f"{entity_type}-{entity_id}",
            "op": op,
        }

        # Include data for create/update
        if op in ["create", "update"] and entity_data:
            message["data"] = entity_data

        message_json = json.dumps(message)

        # Determine recipients
        active_conns = get_active_connections()
        recipients = None

        if op == "create":
            # Broadcast creates to all connected clients
            recipients = set(active_conns.keys())
            logger.debug(f"Broadcasting {op} to {len(recipients)} clients")
        else:
            # Send updates/deletes only to explicit watchers
            recipients = get_watched_by(entity_key)
            logger.debug(f"Sending {op} to {len(recipients)} watchers of {entity_key}")

        if not recipients:
            logger.debug(f"No recipients for {entity_key} ({op})")
            return

        # Send to all recipients
        sent_count = 0
        for connection_id in recipients:
            ws = active_conns.get(connection_id)
            if ws:
                try:
                    await ws.send_text(message_json)
                    sent_count += 1
                except Exception as e:
                    logger.error(f"Failed to send {op} notification to {connection_id}: {e}")

        logger.info(f"Sent {op} notification for {entity_key} to {sent_count}/{len(recipients)} clients")

    except Exception as e:
        logger.error(f"Error sending entity notification: {e}", exc_info=True)


async def handle_binary_message(connection_id: str, websocket: WebSocket, data: bytes) -> None:
    """Handle incoming binary WebSocket message (STREAM_MSG).

    Binary messages use msgpack encoding and are used for streaming data
    (file uploads, binary data transfer, etc.).

    Ported from FlowPad: flowpad/hub/routers/websocket.py binary handling.
    Desktop stub: logs the binary message. Full msgpack decoding can be
    added when WSBinaryStream support is needed.
    """
    logger.debug(f"Binary message from {connection_id}: {len(data)} bytes")

    # Try to decode as msgpack if available
    try:
        import msgpack

        decoded = msgpack.unpackb(data, raw=False)
        logger.debug(f"Binary msgpack message from {connection_id}: {type(decoded)}")

        # If it has a message_type, handle it
        if isinstance(decoded, dict):
            msg_type = decoded.get("message_type", "")
            if msg_type == "stream_msg":
                # Stream messages are for binary data transfer
                # Desktop mode: acknowledge receipt
                logger.info(f"Stream message from {connection_id}: {len(data)} bytes")
    except ImportError:
        logger.debug(f"msgpack not available, cannot decode binary message from {connection_id}")
    except Exception as e:
        logger.warning(f"Failed to decode binary message from {connection_id}: {e}")


async def handle_json_message(connection_id: str, websocket: WebSocket, message_data: dict) -> bool:
    """
    Handle incoming JSON message.

    Returns False if client should disconnect (hangup), True otherwise.
    """
    if "message_type" not in message_data:
        logger.warning(f"Invalid message from {connection_id}: missing message_type")
        return True

    message_type = message_data.get("message_type")

    try:
        if message_type == "echo":
            # Echo the message back
            message_data["message_id"] = str(uuid4())
            await send_personal_message(json.dumps(message_data), websocket)

        elif message_type == "ping":
            # Respond with pong
            pong = {
                "message_type": "pong",
                "message_id": str(uuid4()),
                "text": message_data.get("text", "pong"),
            }
            await send_personal_message(json.dumps(pong), websocket)

        elif message_type == "broadcast":
            # Broadcast to all connected clients
            broadcast_msg = {
                "message_type": "broadcast",
                "message_id": str(uuid4()),
                "from_connection": connection_id,
                "content": message_data.get("content", ""),
            }
            await broadcast(json.dumps(broadcast_msg))

        elif message_type == "hangup":
            # Client requests disconnect
            logger.info(f"Client {connection_id} requested hangup")
            return False

        elif message_type == "rest_api_msg":
            # Handle REST API message over WebSocket
            message_context = contextvars.copy_context()
            await message_context.run(handle_rest_message, connection_id, websocket, message_data)

        elif message_type == "oauth_msg":
            # Handle OAuth messages - forward to target or log
            oauth_request_id = message_data.get("oauth_request_id")
            status = message_data.get("status")
            logger.info(f"OAuth message from {connection_id}: request_id={oauth_request_id}, status={status}")
            # In desktop mode, OAuth messages are logged but not forwarded
            # (no multi-user OAuth coordination needed)
            response = {
                "message_type": "response_msg",
                "message_id": str(uuid4()),
                "response_message_id": message_data.get("message_id"),
                "status": "ok",
                "data": {"received": True, "oauth_request_id": oauth_request_id},
            }
            await send_personal_message(json.dumps(response), websocket)

        elif message_type == "entity_msg":
            # Handle entity-scoped messages - forward to target entity watchers or log
            to_entity = message_data.get("to_entity")
            from_entity = message_data.get("from_entity")
            logger.info(f"Entity message from {connection_id}: from={from_entity}, to={to_entity}")

            # Forward to watchers of the target entity if any
            if to_entity:
                try:
                    from flow_sdk.app.actions.watch_registry import get_watched_by

                    entity_key = (
                        to_entity
                        if isinstance(to_entity, str)
                        else f"{to_entity.get('type', '')}-{to_entity.get('id', '')}"
                    )
                    watchers = get_watched_by(entity_key)
                    active_conns = get_active_connections()
                    forwarded = 0
                    for watcher_id in watchers:
                        if watcher_id != connection_id:  # Don't echo back to sender
                            ws = active_conns.get(watcher_id)
                            if ws:
                                try:
                                    await ws.send_text(json.dumps(message_data))
                                    forwarded += 1
                                except Exception as e:
                                    logger.warning(f"Failed to forward entity_msg to {watcher_id}: {e}")
                    logger.debug(f"Forwarded entity_msg to {forwarded} watchers of {entity_key}")
                except Exception as e:
                    logger.warning(f"Error forwarding entity_msg: {e}")

        else:
            logger.warning(f"Unknown message type from {connection_id}: {message_type}")
            error_response = {
                "message_type": "response_msg",
                "response_message_id": message_data.get("message_id"),
                "status": "error",
                "error": f"Unknown message type: {message_type}",
            }
            await send_personal_message(json.dumps(error_response), websocket)

        return True

    except Exception as e:
        logger.error(f"Error handling message from {connection_id}: {type(e).__name__}: {e}")
        error_response = {
            "message_type": "response_msg",
            "response_message_id": message_data.get("message_id"),
            "status": "error",
            "error": str(e),
        }
        try:
            await send_personal_message(json.dumps(error_response), websocket)
        except Exception:
            pass
        return True


@websocket_router.websocket("/api/v1/connect/ws/{connection_id}")
async def websocket_endpoint(websocket: WebSocket, connection_id: str):
    """
    WebSocket endpoint for client connections.

    Accepts connections at /api/v1/connect/ws/{connection_id} and handles JSON messages.

    Message Types:
    - echo: Echo message back to client
    - ping: Send ping, receive pong
    - broadcast: Send message to all connected clients
    - hangup: Close connection
    """
    logger.info(f"WebSocket endpoint called for connection_id={connection_id}")
    try:
        await websocket.accept()
        logger.info(f"WebSocket accepted for connection_id={connection_id}")
    except Exception as e:
        logger.error(f"Failed to accept WebSocket for connection_id={connection_id}: {e}")
        return

    _active_connections[connection_id] = websocket
    add_registry_connection(connection_id, websocket)

    logger.info(f"Client {connection_id} connected. Total connections: {len(_active_connections)}")

    # Send connection confirmation
    confirmation = {
        "message_type": "response_msg",
        "message_id": str(uuid4()),
        "status": "ok",
        "data": {
            "connection_id": connection_id,
            "message": "Connected to Flowpad WebSocket server",
        },
    }
    await send_personal_message(json.dumps(confirmation), websocket)

    try:
        while True:
            # Receive message (text or binary)
            try:
                message = await websocket.receive()
            except Exception:
                break

            msg_type = message.get("type", "")

            if msg_type == "websocket.disconnect":
                break

            # Handle binary messages (STREAM_MSG - msgpack encoded)
            if msg_type == "websocket.receive" and "bytes" in message and message["bytes"]:
                await handle_binary_message(connection_id, websocket, message["bytes"])
                continue

            # Handle text messages (JSON)
            raw_data = message.get("text", "")
            if not raw_data:
                continue

            try:
                message_data = json.loads(raw_data)
            except json.JSONDecodeError as e:
                logger.warning(f"Invalid JSON from {connection_id}: {e}")
                # Can't respond with response_message_id since JSON parsing failed
                error_response = {
                    "message_type": "response_msg",
                    "message_id": str(uuid4()),
                    "status": "error",
                    "error": f"Invalid JSON: {str(e)}",
                }
                try:
                    await send_personal_message(json.dumps(error_response), websocket)
                except Exception:
                    break
                continue

            # Handle message
            continue_loop = await handle_json_message(connection_id, websocket, message_data)
            if not continue_loop:
                break

    except WebSocketDisconnect:
        logger.info(f"Client {connection_id} disconnected")
    except Exception as e:
        logger.error(f"Error in WebSocket connection {connection_id}: {e}")
    finally:
        # Clean up connection
        _active_connections.pop(connection_id, None)
        remove_registry_connection(connection_id)

        # Clean up watches
        from flow_sdk.app.actions.watch_registry import cleanup_connection

        cleanup_connection(connection_id)

        # Detach this connection from all PTY sessions so stale connection_ids
        # don't accumulate.  This only removes the connection reference — it does
        # NOT close PTY processes (they stay alive for reconnection).
        try:
            import asyncio

            from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager as pty_mgr

            asyncio.ensure_future(pty_mgr.detach_all_for_connection(connection_id))
        except Exception as e:
            logger.warning(f"Error detaching PTY sessions for {connection_id}: {e}")

        logger.info(f"Client {connection_id} removed. Remaining connections: {len(_active_connections)}")


def get_connection_count() -> int:
    """Get count of active connections."""
    return len(_active_connections)
