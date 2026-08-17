"""Process-level registry of live Docker worker WS connections.

Each worker (inside a container) dials OUT to the outer server via WS and sends
a `compute_connect` handshake with `{machine_id, secret}`. After auth the WS
speaks the EXISTING wire protocol the browser<->server WS uses:

- outer → worker: `rest_api_msg` (same shape as ts_sdk ConnectionManager.sendRestApiMessage)
- worker → outer: `response_msg` (correlated by `response_message_id`)
- worker → outer: `pty_output_msg` (async PTY output stream)

DockerComputeProvider looks up the live WorkerConn by machine_id and issues
action calls via `send_action(action, sub_path, body)` — the worker's
dispatcher maps them to its in-process LocalComputeProvider.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Any, Callable

from flow_sdk.api.messages import WSMessageType

service_log = logging.getLogger(__name__)


# Timeouts for outer→worker RPCs. Keep tight — worker-side dispatch is O(ms);
# only sandbox boot takes noticeable time, and that lives inside pty_create.
ACTION_TIMEOUT_FAST = 10.0     # input, resize — single-shot RPC
ACTION_TIMEOUT_NORMAL = 30.0   # create, close — may spawn processes / flush


class WorkerConn:
    """Owns one WS connection to a Docker worker, routes RPC frames + PTY output."""

    def __init__(self, machine_id: str, ws: Any, container_name: str = "") -> None:
        self.machine_id = machine_id
        self.ws = ws
        self.container_name = container_name
        self._pending: dict[str, asyncio.Future] = {}
        self._pty_callbacks: dict[str, Callable[[bytes], None]] = {}
        self._reader_task: asyncio.Task | None = None

    def start_reader(self) -> None:
        self._reader_task = asyncio.create_task(
            self._read_loop(), name=f"docker_reader_{self.machine_id[:8]}"
        )

    async def wait_reader(self) -> None:
        """Block until the reader task ends (WS disconnect)."""
        if self._reader_task is not None:
            try:
                await self._reader_task
            except Exception:
                pass

    def active_shell_ids(self) -> list[str]:
        return list(self._pty_callbacks.keys())

    async def _read_loop(self) -> None:
        try:
            async for raw in self.ws.iter_text():
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    service_log.warning(f"[DockerRegistry] bad JSON from worker {self.machine_id[:8]}")
                    continue
                mtype = frame.get("message_type")
                if mtype == WSMessageType.RESPONSE_MSG.value:
                    req_id = frame.get("response_message_id")
                    fut = self._pending.pop(req_id, None)
                    if fut is None or fut.done():
                        continue
                    err = frame.get("error")
                    if err:
                        fut.set_exception(RuntimeError(err))
                    else:
                        fut.set_result(frame.get("content"))
                elif mtype == WSMessageType.PTY_OUTPUT_MSG.value:
                    shell_id = frame.get("shell_id")
                    data_b64 = frame.get("data")
                    cb = self._pty_callbacks.get(shell_id) if shell_id else None
                    if cb and data_b64:
                        cb(base64.b64decode(data_b64))
                else:
                    service_log.debug(f"[DockerRegistry] unhandled message_type from worker: {mtype}")
        except Exception as e:
            service_log.warning(f"[DockerRegistry] reader for {self.machine_id[:8]} ended: {e}")
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("worker disconnected"))
            self._pending.clear()

    async def send_action(
        self,
        action: str,
        sub_path: str,
        body: dict,
        timeout: float = ACTION_TIMEOUT_NORMAL,
    ) -> Any:
        """Send `rest_api_msg` to worker and await its `response_msg` content.

        Mirrors the shape emitted by ts_sdk::ConnectionManager.sendRestApiMessage.
        The worker dispatches the (action, sub_path) pair against its in-process
        LocalComputeProvider.
        """
        req_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        frame = json.dumps({
            "message_type": WSMessageType.REST_API_MSG.value,
            "message_id": req_id,
            "method": "POST",
            "scope": [],
            "direct_resource_type": None,
            "target_typeid": None,
            "action": action,
            "sub_path": sub_path,
            "query_params": None,
            "body": body,
        })
        try:
            await self.ws.send_text(frame)
        except Exception as e:
            self._pending.pop(req_id, None)
            raise RuntimeError(f"failed to send action to worker: {e}") from e
        return await asyncio.wait_for(fut, timeout=timeout)

    def register_pty(self, shell_id: str, on_output: Callable[[bytes], None]) -> None:
        self._pty_callbacks[shell_id] = on_output

    def unregister_pty(self, shell_id: str) -> None:
        self._pty_callbacks.pop(shell_id, None)

    def is_pty_alive(self, shell_id: str) -> bool:
        return shell_id in self._pty_callbacks

    async def close(self) -> None:
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        try:
            await self.ws.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Module-level singleton registry
# ---------------------------------------------------------------------------

_workers: dict[str, WorkerConn] = {}


class DuplicateWorkerError(RuntimeError):
    """Raised when a second worker tries to register with an already-live machine_id."""


def _invalidate_bootstrap_provider_state() -> None:
    """Make provider availability reflect this registry transition immediately."""
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    invalidate_bootstrap_cache()


def register(machine_id: str, ws: Any, container_name: str = "") -> WorkerConn:
    """Register a worker. Rejects duplicate machine_id when the existing WS is still alive.

    A second worker with the same machine_id is almost always a ghost process that
    kept retry-looping after a server bounce. Silently overwriting would leak the
    old WS and leave the registry pointing at whichever won the race, which may
    be running stale code. Instead we reject the newcomer — the client surfaces
    a clear error, and the operator can kill the ghost.
    """
    existing = _workers.get(machine_id)
    if existing is not None and existing._reader_task is not None and not existing._reader_task.done():
        raise DuplicateWorkerError(
            f"machine_id {machine_id[:8]} already registered (container={existing.container_name})"
        )
    conn = WorkerConn(machine_id, ws, container_name)
    is_new_machine = machine_id not in _workers
    _workers[machine_id] = conn
    conn.start_reader()
    # Only a change to the worker SET changes provider availability. A flapping
    # container reconnecting under the same machine_id must not discard the
    # whole bootstrap cache and make the next requester pay a full rebuild.
    if is_new_machine:
        _invalidate_bootstrap_provider_state()
    service_log.info(f"[DockerRegistry] registered worker {machine_id[:8]} (container={container_name})")
    return conn


def get(machine_id: str) -> WorkerConn | None:
    return _workers.get(machine_id)


async def unregister(machine_id: str) -> None:
    conn = _workers.pop(machine_id, None)
    if conn:
        await conn.close()
        _invalidate_bootstrap_provider_state()
        service_log.info(f"[DockerRegistry] unregistered worker {machine_id[:8]}")


def list_workers() -> list[dict]:
    return [{"machine_id": m, "container_name": c.container_name} for m, c in _workers.items()]
