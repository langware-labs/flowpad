"""Entity operation notification handler for minihub.

Sends websocket entity notifications for create/update/delete operations.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from itertools import count
from typing import Any
from uuid import uuid4

from fastapi.encoders import jsonable_encoder

from flow_sdk.tags.envelope import parse_target

logger = logging.getLogger(__name__)


# Producers each carry a private ``BaseMessage._counter``; those values cannot
# order a mixed stream. Stamp the authoritative sequence at the one outbound
# funnel, before per-connection send tasks can complete out of order. A
# reconnect gets a new socket and the client resets its accepted-sequence map.
_DATA_OP_WIRE_SEQUENCE = count(1)


def _extract_entity_parts(to_entity: Any) -> tuple[str | None, str | None, str | None]:
    """Normalize to_entity into (type, id, type-id string)."""
    entity_type, entity_id = parse_target(to_entity)
    if not entity_type or not entity_id:
        return None, None, None
    return str(entity_type), str(entity_id), f"{entity_type}-{entity_id}"


def _to_message_dict(op_message: Any) -> dict:
    """Serialize supported DataOpMessage variants to a plain JSON-safe dict."""
    if isinstance(op_message, dict):
        data = op_message
    elif hasattr(op_message, "model_dump"):
        data = op_message.model_dump()  # DataOpMessage (api_types.messages)
    else:
        raise TypeError(f"Unsupported op_message type: {type(op_message)}")

    if not isinstance(data, dict):
        raise TypeError(f"Serialized op_message is not a dict: {type(data)}")

    return jsonable_encoder(data, exclude_none=True)


def _prepare_data_op_message(op_message: Any) -> dict:
    """Serialize one DataOp and assign its process-wide wire order."""
    message = _to_message_dict(op_message)
    message["instance_id"] = next(_DATA_OP_WIRE_SEQUENCE)
    return message


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
    # child_* ops route like update/delete — addressed to the parent, delivered
    # to whoever watches it — so they need the same fallback. Without them here
    # a child frame with no explicit parent watcher resolves to zero recipients
    # and is silently dropped.
    if not recipients and op in ("update", "delete", "child_created", "child_updated", "child_deleted"):
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
    from flow_sdk.core.network.connections import is_client_gone

    try:
        for payload in payloads:
            await ws.send_text(json.dumps(payload))
    except Exception as e:
        # Fire-and-forget task: a client that disconnected mid-notification is
        # normal, not a server error. Swallow it (logged at debug) so asyncio
        # does not surface an unretrieved-task-exception traceback.
        if is_client_gone(e):
            logger.debug("Skipped notification to disconnected client: %s", e)
        else:
            logger.warning("Failed to send entity notification: %s", e)


def _sync_handle_entity_op(op_message: Any):
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

        message = _prepare_data_op_message(op_message)
        op = str(message.get("op", "")).lower()
        entity_type, entity_id, type_id = _extract_entity_parts(message.get("to_entity"))
        if type_id:
            message["to_entity"] = type_id

        # Explicit watchers (a UI connection that called ``watch`` on this
        # entity) always receive update/delete ops — even for types absent from
        # the api-visible schema set. AgenticProcess is runtime-only (not in the
        # bootstrap schemas, so ``api_visible_by_type`` is False) yet IS watched
        # and cached by the FE; without this, a persistent-field change like a
        # file→process cross-link (private_context_entities) never reaches the
        # watching client and its cached entity goes stale.
        from flow_sdk.app.actions.watch_registry import get_watched_by

        explicit_watchers: set[str] = set()
        if (
            entity_type
            and entity_id
            and op
            in (
                "update",
                "delete",
                "child_created",
                "child_updated",
                "child_deleted",
            )
        ):
            explicit_watchers = {c for c in get_watched_by(f"{entity_type}:{entity_id}") if c in active_connections}

        # Skip notifications for non-API-visible entity types UNLESS an explicit
        # watcher asked for this entity. The create / broadcast-to-all fallback
        # still honors the gate so internal-type churn isn't spammed to everyone.
        if entity_type and not explicit_watchers:
            try:
                from flow_sdk.core.entity.entity_model import Entity

                if not Entity.api_visible_by_type(entity_type):
                    logger.debug(f"Skipping WS notification for non-API-visible type: {entity_type}")
                    return
            except Exception:
                pass

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


async def handle_entity_op(op_message: Any):
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
        message = json.dumps(
            {
                "message_type": "flow_data_msg",
                "message_id": str(uuid4()),
                "to_entity": to_entity,
                "flow_data": flow_data,
            }
        )
        for ws in active_connections.values():
            try:
                await ws.send_text(message)
            except Exception:
                pass
    except Exception as e:
        logger.error(f"Error broadcasting progress: {e}", exc_info=True)


def make_flow_message_progress_emitter(fm_id: str, phase: str):
    """Build an async ``on_progress(bytes_done, bytes_total)`` callback that
    fans a ``flow_data_msg`` for a FlowMessage's body upload/download bar.

    ``phase`` is ``"upload"`` or ``"download"`` — it becomes the flow_data
    ``element_type`` (``upload_progress`` / ``download_progress``) the UI's
    ``useFlowMessageProgress`` hook filters on. Broadcast (not watcher-scoped)
    so the bar shows regardless of whether the FM is registered as watched.
    """
    to_entity = f"flow_message-{fm_id}"
    element_type = f"{phase}_progress"

    async def _emit(bytes_done: int, bytes_total: int) -> None:
        try:
            await broadcast_progress(
                to_entity,
                {
                    "element_type": element_type,
                    "attributes": {
                        "flow_message_id": fm_id,
                        "bytes_done": bytes_done,
                        "bytes_total": bytes_total,
                    },
                },
            )
        except Exception:  # noqa: BLE001
            pass

    return _emit
