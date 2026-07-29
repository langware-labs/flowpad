"""Inner-container worker — dials out to the outer flow_sdk server via WS.

After the handshake, the WS speaks the standard flow_sdk wire protocol:

  outer → worker:  `rest_api_msg` carrying `action="terminal-command"` + sub_path
  worker → outer:  `response_msg` (correlated by `response_message_id`)
  worker → outer:  `pty_output_msg` (async PTY stream)

The worker's dispatcher is a small switch on (action, sub_path) that calls
the in-container LocalComputeProvider directly — no ExecutionContext rebuild.

Env vars set by `flow compute connect`:
  MACHINE_ID       UUID identifying this worker.
  FLOW_CONNECT_KEY shared secret for the handshake.
  FLOW_OUTER_URL   WebSocket URL of the outer server.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import signal
import sys
import time
import uuid
from pathlib import Path

from flow_sdk.api.messages import PtyOutputMessage, WSMessageType

service_log = logging.getLogger(__name__)


# Handshake frame types — no existing equivalent in the wire protocol.
HANDSHAKE_CONNECT = "compute_connect"
HANDSHAKE_CONNECTED = "compute_connected"
HANDSHAKE_ERROR = "error"


def _signal_connected(ready_path: str, connected_path: str) -> None:
    """Publish the completed handshake to the provisioning CLI.

    The regular marker lets the detached supervisor distinguish a later worker
    exit from a pre-handshake failure. The ready path is normally a FIFO, so
    this write releases exactly the ``flow compute connect --start`` caller
    waiting for provider registration.
    """
    if not ready_path or not connected_path:
        return
    Path(connected_path).write_text("connected\n", encoding="utf-8")
    Path(ready_path).write_text("ready\n", encoding="utf-8")


async def _run_worker(
    machine_id: str,
    secret: str,
    outer_url: str,
    container_name: str = "",
    ready_path: str = "",
    connected_path: str = "",
) -> None:
    """Connect to the outer server and serve `rest_api_msg` forever."""
    try:
        import websockets
    except ImportError:
        print("ERROR: `websockets` package is required. Install with: pip install websockets", file=sys.stderr)
        sys.exit(1)

    from flow_sdk.compute.providers.desktop import LocalComputeProvider

    provider = LocalComputeProvider()
    pty_sessions: dict[str, dict] = {}
    pn_id = f"worker_{machine_id[:8]}"

    backoff = 1.0
    while True:
        try:
            service_log.info(f"[worker] connecting to {outer_url} (machine_id={machine_id[:8]})")
            async with websockets.connect(outer_url) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": HANDSHAKE_CONNECT,
                            "machine_id": machine_id,
                            "secret": secret,
                            "container_name": container_name,
                        }
                    )
                )

                reply = json.loads(await ws.recv())
                if reply.get("type") == HANDSHAKE_ERROR:
                    service_log.error(f"[worker] handshake rejected: {reply.get('error')}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                    continue

                service_log.info("[worker] connected to outer server")
                _signal_connected(ready_path, connected_path)
                backoff = 1.0

                async for raw in ws:
                    try:
                        frame = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    if frame.get("message_type") != WSMessageType.REST_API_MSG.value:
                        continue

                    request_id = frame.get("message_id")
                    try:
                        content = await _dispatch(provider, pn_id, pty_sessions, ws, frame)
                        await ws.send(
                            json.dumps(
                                {
                                    "message_type": WSMessageType.RESPONSE_MSG.value,
                                    "message_id": uuid.uuid4().hex,
                                    "response_message_id": request_id,
                                    "content": content,
                                }
                            )
                        )
                    except Exception as e:
                        service_log.warning(f"[worker] dispatch error: {e}")
                        await ws.send(
                            json.dumps(
                                {
                                    "message_type": WSMessageType.RESPONSE_MSG.value,
                                    "message_id": uuid.uuid4().hex,
                                    "response_message_id": request_id,
                                    "error": str(e),
                                }
                            )
                        )

        except (ConnectionRefusedError, OSError) as e:
            service_log.warning(f"[worker] connection failed: {e}; retry in {backoff:.0f}s")
        except Exception as e:
            service_log.warning(f"[worker] disconnected: {e}; retry in {backoff:.0f}s")

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


async def _dispatch(
    provider: "LocalComputeProvider",
    pn_id: str,
    pty_sessions: dict[str, dict],
    ws,
    frame: dict,
) -> dict | None:
    """Route an inbound `rest_api_msg` to a LocalComputeProvider call."""
    action = frame.get("action") or ""
    sub_path = frame.get("sub_path") or ""
    body = frame.get("body") or {}

    if action != "terminal-command":
        raise RuntimeError(f"unsupported action: {action}")

    shell_id = body.get("shell_id")
    if not shell_id:
        raise RuntimeError("shell_id required")

    if sub_path == "start":
        loop = asyncio.get_event_loop()

        def on_output(data: bytes) -> None:
            try:
                msg = PtyOutputMessage.from_bytes(
                    provider_node_id=pn_id,
                    shell_id=shell_id,
                    data=data,
                    timestamp=time.time(),
                )
                asyncio.run_coroutine_threadsafe(ws.send(msg.model_dump_json()), loop)
            except Exception as e:
                service_log.warning(f"[worker] failed to send pty_output_msg: {e}")

        result = await provider.get_or_create_pty_session(
            provider_node_id=pn_id,
            session_id=shell_id,
            on_output=on_output,
            rows=body.get("rows", 24),
            cols=body.get("cols", 80),
            working_dir=body.get("working_dir"),
            spawn_args=body.get("spawn_args"),
            extra_env=body.get("extra_env"),
        )
        pty_sessions[shell_id] = {"pn_id": pn_id}
        return {"pid": result.get("pid")}

    elif sub_path == "input":
        info = pty_sessions.get(shell_id)
        if info is None:
            raise RuntimeError(f"PTY session not found: {shell_id}")
        data = base64.b64decode(body.get("data", ""))
        await provider.send_pty_input(
            info["pn_id"],
            shell_id,
            data,
            body.get("cols", 80),
            body.get("rows", 24),
        )
        return None

    elif sub_path == "resize":
        info = pty_sessions.get(shell_id)
        if info is None:
            raise RuntimeError(f"PTY session not found: {shell_id}")
        await provider.resize_pty(
            info["pn_id"],
            shell_id,
            body.get("cols", 80),
            body.get("rows", 24),
        )
        return None

    elif sub_path == "close":
        info = pty_sessions.pop(shell_id, None)
        if info:
            await provider.close_pty_session(info["pn_id"], shell_id)
        return None

    else:
        raise RuntimeError(f"unsupported sub_path: {sub_path}")


def run() -> None:
    """Entry point for `flow compute worker`."""
    machine_id = os.environ.get("MACHINE_ID", "")
    secret = os.environ.get("FLOW_CONNECT_KEY", "")
    outer_url = os.environ.get("FLOW_OUTER_URL", "")
    container_name = os.environ.get("CONTAINER_NAME", os.environ.get("HOSTNAME", ""))
    ready_path = os.environ.get("FLOW_WORKER_READY_PATH", "")
    connected_path = os.environ.get("FLOW_WORKER_CONNECTED_PATH", "")

    if not machine_id or not secret or not outer_url:
        print(
            "ERROR: MACHINE_ID, FLOW_CONNECT_KEY, and FLOW_OUTER_URL must be set.\n"
            "These are written by `flow compute connect <container>`.",
            file=sys.stderr,
        )
        sys.exit(1)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    service_log.info(f"[worker] starting (machine_id={machine_id[:8]}, outer_url={outer_url})")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _shutdown(*_):
        service_log.info("[worker] shutting down")
        for task in asyncio.all_tasks(loop):
            task.cancel()
        loop.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        loop.run_until_complete(
            _run_worker(
                machine_id,
                secret,
                outer_url,
                container_name,
                ready_path,
                connected_path,
            )
        )
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        loop.close()
