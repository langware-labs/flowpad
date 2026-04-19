"""WebSocket route accepting inbound connections from Docker compute workers.

Workers inside containers dial OUT to this endpoint with a `compute_connect`
handshake carrying `{machine_id, secret}`. After auth the WS speaks the
standard flow_sdk wire protocol (`rest_api_msg` / `response_msg` /
`pty_output_msg`) — see `docker_registry.WorkerConn`.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

service_log = logging.getLogger(__name__)

compute_register_router = APIRouter()


# Handshake frames — no existing equivalent in the wire protocol.
HANDSHAKE_CONNECT = "compute_connect"
HANDSHAKE_CONNECTED = "compute_connected"
HANDSHAKE_ERROR = "error"


@compute_register_router.websocket("/api/v1/compute/ws")
async def compute_worker_ws(ws: WebSocket) -> None:
    await ws.accept()
    machine_id: str | None = None
    try:
        msg = json.loads(await ws.receive_text())
        if msg.get("type") != HANDSHAKE_CONNECT:
            await ws.send_text(json.dumps({"type": HANDSHAKE_ERROR, "error": "expected compute_connect message"}))
            await ws.close()
            return

        machine_id = msg.get("machine_id", "")
        secret = msg.get("secret", "")
        container_name = msg.get("container_name", "")

        if not machine_id or not secret:
            await ws.send_text(json.dumps({"type": HANDSHAKE_ERROR, "error": "missing machine_id or secret"}))
            await ws.close()
            return

        # Validate against the outer @docker-<name> ComputeNode entity.
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        cn = await ComputeNode.get_one({"node_provider_id": machine_id})
        if cn is None:
            service_log.warning(f"[compute/ws] unknown machine_id {machine_id[:8]}")
            await ws.send_text(json.dumps({"type": HANDSHAKE_ERROR, "error": "unknown machine_id"}))
            await ws.close()
            return

        stored_secret = (cn.node_config or {}).get("secret", "")
        if secret != stored_secret:
            service_log.warning(f"[compute/ws] bad secret for machine_id {machine_id[:8]}")
            await ws.send_text(json.dumps({"type": HANDSHAKE_ERROR, "error": "invalid secret"}))
            await ws.close()
            return

        # Register the live connection. WorkerConn.start_reader() takes ownership
        # of reading WS frames — this route must NOT also call `ws.receive_*()`,
        # or the two readers will race and steal each other's frames.
        from flow_sdk.compute.providers.docker.docker_registry import DuplicateWorkerError, register
        try:
            conn = register(machine_id, ws, container_name)
        except DuplicateWorkerError as e:
            service_log.warning(f"[compute/ws] rejecting duplicate worker: {e}")
            await ws.send_text(json.dumps({"type": HANDSHAKE_ERROR, "error": str(e)}))
            await ws.close()
            # DO NOT run unregister() below: the existing live WorkerConn is valid
            # and we must not tear it down just because a ghost dialed in.
            machine_id = None
            return
        await ws.send_text(json.dumps({"type": HANDSHAKE_CONNECTED, "machine_id": machine_id}))
        service_log.info(f"[compute/ws] worker {machine_id[:8]} connected (container={container_name})")

        # Block until the reader ends (WS disconnect).
        await conn.wait_reader()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        service_log.warning(f"[compute/ws] error: {e}")
    finally:
        if machine_id:
            from flow_sdk.compute.providers.docker.docker_registry import unregister
            await unregister(machine_id)
            service_log.info(f"[compute/ws] worker {machine_id[:8]} disconnected")
