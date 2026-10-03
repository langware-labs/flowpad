"""The ``flow connect`` worker: this machine, served to the hub over one WebSocket.

The hub's ``UserMachineComputeProvider`` cannot reach a laptop behind NAT, so the
laptop reaches the hub: this worker dials ``/api/v1/compute-node/{node_id}/ws``
with the owner's hub credentials, introduces itself with a hello frame, and then
answers requests until it is stopped. Everything the hub does to an E2B sandbox it
does to this machine through the same frames:

  hub → us   ``rest_api_msg``  ``{message_id, action: "compute-node", sub_path, body}``
  us → hub   ``response_msg``  ``{response_message_id, content | error}``
  us → hub   ``cmd_status_msg`` streamed stdout/stderr/exit_code of a ``run``
  us → hub   ``pty_output_msg`` streamed terminal bytes of a PTY session

Commands and PTYs execute as the user who ran ``flow connect``, from that user's
home directory, with ``flow`` on PATH so the hub's own workspace bootstrap
(``flow stop; flow start service``) works unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import logging
import os
import platform
import re
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from flow_sdk.cloud_client.ws_client import (
    AUTH_WS_CLOSE_CODES,
    AUTH_WS_STATUS_CODES,
    _exception_status_code,
    _hub_ssl_context,
    build_hub_ws_path_url,
)
from flow_sdk.compute.user_machine.control_shell import ControlShells, command_script
from flow_sdk.config import PLATFORM_WIN32

logger = logging.getLogger(__name__)

NODE_ACTION = "compute-node"
RECONNECT_MIN = 1.0
RECONNECT_MAX = 30.0


class WorkerAuthRejected(RuntimeError):
    """The hub refused our credentials or our claim to this node — do not retry."""


def build_hub_node_ws_url(api_base_url: str, node_id: str) -> str:
    """``https://hub/api/v1`` + node → ``wss://hub/api/v1/compute-node/<id>/ws``."""
    return build_hub_ws_path_url(api_base_url, f"/compute-node/{node_id}/ws")


@functools.cache
def _flow_bin_dir() -> str | None:
    exe = shutil.which("flow") or (sys.argv[0] if sys.argv and sys.argv[0].endswith("flow") else None)
    if exe:
        return str(Path(exe).resolve().parent)
    return None


def _command_env(extra: dict[str, str] | None) -> dict[str, str]:
    env = dict(os.environ)
    bin_dir = _flow_bin_dir()
    if bin_dir:
        env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    if extra:
        env.update({str(k): str(v) for k, v in extra.items()})
    return env


@functools.cache
def _powershell() -> str | None:
    """The PowerShell that runs the hub's commands on Windows — the same one a terminal gets."""
    if sys.platform != PLATFORM_WIN32:
        return None
    from flow_sdk.compute.providers.desktop.provider import default_terminal_shell

    shell = default_terminal_shell()
    return shell if Path(shell).stem.lower() in ("pwsh", "powershell") else None


def control_shell_kind() -> str:
    """``powershell`` or ``posix``: the grammar of a ``run`` command on this machine."""
    return "powershell" if _powershell() else "posix"


def _expand(path: str) -> Path:
    return Path(os.path.expanduser(path))


class UserMachineWorker:
    """One connection's worth of state: running commands, PTY sessions, the socket."""

    def __init__(
        self,
        *,
        node_id: str,
        machine_id: str,
        ws_url: str,
        headers: dict[str, str],
        ssl_context: Any = None,
        home_dir: str | None = None,
        on_connected: Callable[[], None] | None = None,
        on_activity: Callable[[str], None] | None = None,
    ) -> None:
        self.node_id = node_id
        self.machine_id = machine_id
        self.ws_url = ws_url
        self.headers = headers
        self.ssl_context = ssl_context
        self.home_dir = home_dir or str(Path.home())
        self.on_connected = on_connected
        self.on_activity = on_activity
        self.stop_event = asyncio.Event()
        self._ws: Any = None
        self._send_lock = asyncio.Lock()
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._tasks: set[asyncio.Task] = set()
        self._provider = None  # LocalComputeProvider, created lazily (imports pty machinery)
        self._pty_sessions: set[str] = set()
        # Windows: the hub's commands run in the machine's control shells (PowerShell).
        self._powershells: ControlShells | None = None
        # Commands acknowledged but still waiting for a warm PowerShell.
        self._waiting: dict[str, asyncio.Task] = {}
        self._handlers: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {
            "run": self._op_run,
            "cancel": self._op_cancel,
            "exists": self._op_exists,
            "read_files": self._op_read_files,
            "write_files": self._op_write_files,
            "list_dir": self._op_list_dir,
            "delete_files": self._op_delete_files,
            "create_folders": self._op_create_folders,
            "set_env": self._op_set_env,
            "pty_start": self._op_pty_start,
            "pty_input": self._op_pty_input,
            "pty_resize": self._op_pty_resize,
            "pty_close": self._op_pty_close,
            "machine_status": self._op_machine_status,
            "shutdown": self._op_shutdown,
        }

    # ------------------------------------------------------------------ hello
    def hello(self) -> dict[str, Any]:
        info = self._local_provider().get_node_info()
        return {
            "message_type": "client_node_ready_msg",
            "node_id": self.node_id,
            "machine_id": self.machine_id,
            "hostname": platform.node(),
            "os_type": info.os_type,
            # The dialect the hub must speak in ``run``: this machine's own shell.
            "control_shell": control_shell_kind(),
            "home_path": self.home_dir,
            "temp_path": tempfile.gettempdir(),
            "cpu_count": info.cpu_count,
            "memory_gb": info.memory_gb,
        }

    # ------------------------------------------------------------------ transport
    async def _send(self, frame: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        async with self._send_lock:
            await ws.send(json.dumps(frame))

    async def _reply(self, request_id: str, content: Any = None, error: str | None = None) -> None:
        frame: dict[str, Any] = {
            "message_type": "response_msg",
            "message_id": uuid.uuid4().hex,
            "response_message_id": request_id,
        }
        if error is not None:
            frame["error"] = error
        else:
            frame["content"] = content
        await self._send(frame)

    async def _cmd_status(self, command_message_id: str, **fields: Any) -> None:
        await self._send({"message_type": "cmd_status_msg", "command_message_id": command_message_id, **fields})

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def run_forever(self) -> None:
        """Connect, serve, reconnect with backoff — until ``stop_event`` or auth rejection."""
        powershell = _powershell()
        if powershell is not None and self._powershells is None:
            self._powershells = ControlShells(powershell, env=_command_env(None), cwd=self.home_dir)
            self._powershells.start()
        try:
            await self._serve_until_stopped()
        finally:
            if self._powershells is not None:
                await self._powershells.close()

    async def _serve_until_stopped(self) -> None:
        import websockets
        from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

        backoff = RECONNECT_MIN
        while not self.stop_event.is_set():
            try:
                logger.info("[connect] dialing %s", self.ws_url)
                async with websockets.connect(
                    self.ws_url,
                    additional_headers=self.headers,
                    open_timeout=15,
                    # Use the same standard HTTP(S)_PROXY discovery as Hub
                    # REST traffic. Restricted cloud sandboxes intentionally
                    # have no direct DNS or Internet route.
                    proxy=True,
                    ssl=self.ssl_context,
                    max_size=64 * 1024 * 1024,
                ) as ws:
                    self._ws = ws
                    await ws.send(json.dumps(self.hello()))
                    first = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if first.get("message_type") != "ws_ready_msg":
                        raise RuntimeError(f"unexpected first frame from hub: {first.get('message_type')!r}")
                    logger.info("[connect] attached as node %s", self.node_id)
                    backoff = RECONNECT_MIN
                    if self.on_connected:
                        self.on_connected()
                    await self._serve(ws)
            except (InvalidStatus, InvalidHandshake) as exc:
                status = _exception_status_code(exc)
                if status in AUTH_WS_STATUS_CODES:
                    raise WorkerAuthRejected(f"hub rejected the connection (HTTP {status})") from exc
                logger.warning("[connect] handshake failed: %s", exc)
            except ConnectionClosed as exc:
                received = getattr(exc, "rcvd", None)
                if getattr(received, "code", None) in AUTH_WS_CLOSE_CODES:
                    raise WorkerAuthRejected(
                        f"hub closed the connection: {getattr(received, 'reason', '') or exc}"
                    ) from exc
                logger.warning("[connect] connection closed: %s", exc)
            except (OSError, asyncio.TimeoutError) as exc:
                logger.warning("[connect] connection failed: %s", exc)
            except Exception as exc:  # noqa: BLE001 — keep serving through transient faults
                logger.warning("[connect] error: %s", exc)
            finally:
                self._ws = None
                await self._teardown_sessions()
            if self.stop_event.is_set():
                break
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, RECONNECT_MAX)

    async def _serve(self, ws: Any) -> None:
        async def read_frames() -> None:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(frame, dict):
                    self._spawn(self._handle(frame))

        reader = asyncio.ensure_future(read_frames())
        stop = asyncio.ensure_future(self.stop_event.wait())
        try:
            done, _ = await asyncio.wait({reader, stop}, return_when=asyncio.FIRST_COMPLETED)
            if reader in done:
                reader.result()  # surfaces ConnectionClosed to run_forever
        finally:
            for fut in (reader, stop):
                if not fut.done():
                    fut.cancel()

    async def _handle(self, frame: dict[str, Any]) -> None:
        message_type = frame.get("message_type")
        if message_type == "ping":
            await self._send({"message_type": "pong", "message_id": uuid.uuid4().hex})
            return
        if message_type != "rest_api_msg":
            return
        request_id = str(frame.get("message_id"))
        sub_path = str(frame.get("sub_path") or "")
        body = frame.get("body") or {}
        if frame.get("action") != NODE_ACTION:
            await self._reply(request_id, error=f"unsupported action {frame.get('action')!r}")
            return
        handler = self._handlers.get(sub_path)
        if handler is None:
            await self._reply(request_id, error=f"unsupported sub_path {sub_path!r}")
            return
        # Shown as it arrives (a run's exit line follows it); a PTY start once it has a pid.
        line = describe_command(sub_path, body)
        if line and sub_path != "pty_start":
            self._activity(line)
        try:
            content = await handler(body)
        except Exception as exc:  # noqa: BLE001 — every failure is reported to the hub, never swallowed
            logger.warning("[connect] %s failed: %s", sub_path, exc)
            if line:
                self._activity(f"{line}  FAILED: {type(exc).__name__}: {exc}")
            await self._reply(request_id, error=f"{type(exc).__name__}: {exc}")
            return
        if line and sub_path == "pty_start":
            self._activity(f"{line} -> pid {content.get('pid')}")
        await self._reply(request_id, content)
        if sub_path == "shutdown":
            self.stop_event.set()

    def _activity(self, line: str) -> None:
        if self.on_activity is not None:
            self.on_activity(line)

    # ------------------------------------------------------------------ commands
    async def _op_run(self, body: dict[str, Any]) -> dict[str, Any]:
        command_message_id = str(body["command_message_id"])
        cmd = str(body["cmd"])
        cwd = str(_expand(body["cwd"])) if body.get("cwd") else self.home_dir
        if self._powershells is not None:
            # Acknowledged at once: the hub gives the ack 15 s, and the control shells
            # may still be starting (the first command lands as the machine connects).
            self._waiting[command_message_id] = self._spawn(
                self._run_in_powershell(command_message_id, cmd, cwd, body.get("env") or None)
            )
            return {"started": True}
        else:
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=_command_env(body.get("env") or None),
                limit=10 * 1024 * 1024,
            )
        self._processes[command_message_id] = process
        self._spawn(self._pump(command_message_id, process))
        return {"started": True, "pid": process.pid}

    async def _run_in_powershell(self, command_message_id: str, cmd: str, cwd: str, env: dict[str, str] | None) -> None:
        """Run ``cmd`` in a control shell, reporting it to the hub exactly as a process is."""
        assert self._powershells is not None
        shell = None
        exit_code: int | None = None
        try:
            shell = await self._powershells.acquire()
            async for out in shell.run(command_script(cmd, cwd, env)):
                if out.exit_code is not None:
                    exit_code = out.exit_code
                elif out.stdout is not None:
                    await self._cmd_status(command_message_id, stdout=out.stdout)
                else:
                    await self._cmd_status(command_message_id, stderr=out.stderr)
        except asyncio.CancelledError:
            if shell is not None:
                self._powershells.discard(shell)  # it is still running the cancelled command
                shell = None
            raise
        except Exception as exc:  # noqa: BLE001 — reported to the hub as the command's failure
            logger.warning("[connect] command %s failed in the control shell: %s", command_message_id, exc)
            if shell is not None:
                self._powershells.discard(shell)
                shell = None
            await self._cmd_status(command_message_id, stderr=f"control shell failed: {exc}\n")
            exit_code = 1
        finally:
            self._waiting.pop(command_message_id, None)
            if shell is not None:
                self._powershells.release(shell)
        if exit_code is not None:
            self._activity(f"run #{command_message_id[:8]} exited {exit_code}")
        if self._ws is not None:
            try:
                await self._cmd_status(command_message_id, exit_code=exit_code, ended=True)
            except Exception:  # noqa: BLE001 — socket gone; the hub already completed it
                pass

    async def _pump(self, command_message_id: str, process: asyncio.subprocess.Process) -> None:
        async def relay(stream: asyncio.StreamReader | None, field: str) -> None:
            if stream is None:
                return
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    return
                await self._cmd_status(command_message_id, **{field: chunk.decode("utf-8", errors="replace")})

        # None when the process's end was lost: the last frame then says it ENDED
        # with no code, rather than inventing -1 ("ran and exited -1").
        exit_code: int | None = None
        try:
            await asyncio.gather(relay(process.stdout, "stdout"), relay(process.stderr, "stderr"))
            exit_code = await process.wait()
            self._activity(f"run #{command_message_id[:8]} exited {exit_code}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("[connect] command %s pump failed: %s", command_message_id, exc)
        finally:
            self._processes.pop(command_message_id, None)
            if self._ws is not None:
                try:
                    await self._cmd_status(command_message_id, exit_code=exit_code, ended=True)
                except Exception:  # noqa: BLE001 — socket gone; the hub already completed it
                    pass

    async def _op_cancel(self, body: dict[str, Any]) -> None:
        waiting = self._waiting.pop(str(body.get("command_message_id")), None)
        if waiting is not None:
            waiting.cancel()
        process = self._processes.get(str(body.get("command_message_id")))
        if process is not None and process.returncode is None:
            process.terminate()

    # ------------------------------------------------------------------ files
    async def _op_exists(self, body: dict[str, Any]) -> dict[str, bool]:
        return {p: _expand(p).exists() for p in body.get("paths", [])}

    async def _op_read_files(self, body: dict[str, Any]) -> dict[str, str]:
        def read_all() -> dict[str, str]:
            return {p: base64.b64encode(_expand(p).read_bytes()).decode("ascii") for p in body.get("paths", [])}

        return await asyncio.to_thread(read_all)

    async def _op_write_files(self, body: dict[str, Any]) -> list[str]:
        def write_all() -> list[str]:
            written = []
            for item in body.get("files", []):
                target = _expand(item["path"])
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(item.get("data") or ""))
                written.append(item["path"])
            return written

        return await asyncio.to_thread(write_all)

    # list/delete/mkdir/set_env keep the desktop provider's exact semantics.
    async def _op_list_dir(self, body: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        paths = [str(_expand(p)) for p in body.get("paths", [])]
        listed = await self._local_provider().list_dir(self.machine_id, paths)
        return {
            original: [{"name": i.name, "remote_path": i.remote_path, "is_dir": i.is_dir} for i in listed[expanded]]
            for original, expanded in zip(body.get("paths", []), paths)
        }

    async def _op_delete_files(self, body: dict[str, Any]) -> None:
        await self._local_provider().delete_files(self.machine_id, [str(_expand(p)) for p in body.get("paths", [])])

    async def _op_create_folders(self, body: dict[str, Any]) -> None:
        await self._local_provider().create_folders(self.machine_id, [str(_expand(p)) for p in body.get("paths", [])])

    async def _op_set_env(self, body: dict[str, Any]) -> None:
        await self._local_provider().set_env(self.machine_id, str(body["name"]), body.get("value"))

    # ------------------------------------------------------------------ pty
    def _local_provider(self):
        if self._provider is None:
            from flow_sdk.compute.providers.desktop import LocalComputeProvider

            self._provider = LocalComputeProvider()
        return self._provider

    async def _op_pty_start(self, body: dict[str, Any]) -> dict[str, Any]:
        session_id = str(body["session_id"])
        loop = asyncio.get_running_loop()

        def on_output(data: bytes) -> None:
            frame = {
                "message_type": "pty_output_msg",
                "session_id": session_id,
                "data": base64.b64encode(data).decode("ascii"),
                "timestamp": time.time(),
            }
            asyncio.run_coroutine_threadsafe(self._send(frame), loop)

        result = await self._local_provider().get_or_create_pty_session(
            provider_node_id=self.machine_id,
            session_id=session_id,
            on_output=on_output,
            rows=int(body.get("rows") or 24),
            cols=int(body.get("cols") or 80),
            working_dir=self.home_dir,
            extra_env={"PATH": _command_env(None)["PATH"]},
        )
        self._pty_sessions.add(session_id)
        return {"pid": result.get("pid")}

    async def _op_pty_input(self, body: dict[str, Any]) -> None:
        await self._local_provider().send_pty_input(
            self.machine_id,
            str(body["session_id"]),
            base64.b64decode(body.get("data") or ""),
            int(body.get("cols") or 80),
            int(body.get("rows") or 24),
        )

    async def _op_pty_resize(self, body: dict[str, Any]) -> None:
        await self._local_provider().resize_pty(
            self.machine_id, str(body["session_id"]), int(body.get("cols") or 80), int(body.get("rows") or 24)
        )

    async def _op_pty_close(self, body: dict[str, Any]) -> None:
        session_id = str(body["session_id"])
        self._pty_sessions.discard(session_id)
        await self._local_provider().close_pty_session(self.machine_id, session_id)

    # ------------------------------------------------------------------ misc
    async def _op_machine_status(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._local_provider().get_machine_status(self.machine_id)

    async def _op_shutdown(self, body: dict[str, Any]) -> dict[str, Any]:
        return {"stopping": True}

    async def _teardown_sessions(self) -> None:
        for task in self._waiting.values():
            task.cancel()
        self._waiting.clear()
        for command_message_id, process in list(self._processes.items()):
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
            self._processes.pop(command_message_id, None)
        if self._provider is not None:
            for session_id in list(self._pty_sessions):
                try:
                    await self._provider.close_pty_session(self.machine_id, session_id)
                except Exception:  # noqa: BLE001
                    pass
            self._pty_sessions.clear()


# Credentials ride in commands as ``flow auth <sub>`` arguments and as HTTP header
# values (the workspace cookie gate's secret, in both): shown by name, never by value.
# Both spellings: sh (`flow auth x -- v`) and PowerShell (`& 'flow' 'auth' 'x' '--' 'v'`).
_FLOW_AUTH_ARGS = re.compile(r"(\bflow(?:\.exe)?'?\s+'?auth'?\s+'?[\w-]+'?)\s+[^;&|\n]*")
_HEADER_VALUES = re.compile(r"((?:-H|--header)'?\s+['\"]?[\w-]+:\s*)[^'\"\s]+")


def describe_command(sub_path: str, body: dict[str, Any]) -> str | None:
    """One console line for a command the hub sent, or None for one that is not shown.

    PTY keystrokes (``pty_input``) are never shown — they are whatever the person types,
    passwords included. ``set_env`` shows names, never values; ``flow auth`` and header
    values are redacted.
    """
    if sub_path == "pty_input":
        return None
    session = body.get("session_id")
    if sub_path == "run":
        where = f" in {body['cwd']}" if body.get("cwd") else ""
        cmd = _HEADER_VALUES.sub(r"\1<redacted>", _FLOW_AUTH_ARGS.sub(r"\1 <redacted>", str(body.get("cmd"))))
        return f"run #{str(body.get('command_message_id', ''))[:8]}{where}: {cmd}"
    if sub_path == "pty_start":
        return f"pty_start session {session} ({body.get('cols') or 80}x{body.get('rows') or 24})"
    if sub_path == "pty_resize":
        return f"pty_resize session {session} {body.get('cols') or 80}x{body.get('rows') or 24}"
    if sub_path == "pty_close":
        return f"pty_close session {session}"
    if sub_path == "cancel":
        return f"cancel run #{str(body.get('command_message_id', ''))[:8]}"
    if sub_path == "set_env":
        return f"set_env {body.get('name')}"
    paths = body.get("paths") or [f.get("path") for f in body.get("files") or [] if isinstance(f, dict)]
    return f"{sub_path} {', '.join(map(str, paths))}" if paths else sub_path


async def run_worker(
    *,
    node_id: str,
    machine_id: str,
    api_base_url: str,
    api_key: str,
    on_connected: Callable[[], None] | None = None,
    on_activity: Callable[[str], None] | None = None,
) -> None:
    """Serve this machine to the hub until stopped or rejected."""
    from flow_sdk.cloud_client.client_hooks import attach_machine_id

    ws_url = build_hub_node_ws_url(api_base_url, node_id)
    headers = {"Authorization": f"Bearer {api_key}"}
    attach_machine_id(headers)
    worker = UserMachineWorker(
        node_id=node_id,
        machine_id=machine_id,
        ws_url=ws_url,
        headers=headers,
        ssl_context=_hub_ssl_context() if ws_url.startswith("wss://") else None,
        on_connected=on_connected,
        on_activity=on_activity,
    )
    await worker.run_forever()
