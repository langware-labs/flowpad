"""Lease the selected instance's standard backend without changing its state."""

from __future__ import annotations

import asyncio
import json
import secrets
import sys
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from filelock import FileLock, Timeout

from flow_sdk._compat import StrEnum


class ServiceLeaseMode(StrEnum):
    BORROWED = "borrowed"
    OWNED = "owned"


@dataclass(frozen=True)
class ServiceGeneration:
    instance: str
    pid: int
    create_time: float
    port: int
    generation: str


@dataclass(frozen=True)
class LocalResponse:
    status: int
    success: bool
    data: Any = None
    message: Optional[str] = None
    error_code: Optional[str] = None


class FlowServiceError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(detail)


class LocalServiceClient:
    """Async client for one resolved service generation."""

    def __init__(self, port: int) -> None:
        import httpx

        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        # The OAuth wait endpoint already owns the protocol deadline. A second
        # HTTP-client deadline would cut that standard wait short.
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=None)

    async def request(
        self,
        method: str,
        path: str,
        json: Any = None,
    ) -> LocalResponse:
        from flow_sdk.instance_settings.cookie_gate import gate_headers

        url = f"{self.base_url}{path}"
        try:
            response = await self._client.request(
                method,
                path,
                json=json,
                headers=gate_headers(url),
            )
        except Exception as exc:  # noqa: BLE001 — typed local-service boundary
            raise FlowServiceError(
                "service_lost",
                str(exc) or "The selected Flow service stopped responding",
            ) from exc
        try:
            payload = response.json()
        except Exception:  # noqa: BLE001
            return LocalResponse(
                status=response.status_code,
                success=False,
                message="Service returned a non-JSON response",
                error_code="invalid_response",
            )
        if not isinstance(payload, dict):
            return LocalResponse(
                status=response.status_code,
                success=False,
                message="Service returned an invalid response envelope",
                error_code="invalid_response",
            )
        envelope_status = str(payload.get("status") or "").upper()
        success = response.is_success and envelope_status in {"SUCCESS", ""}
        data = payload.get("data")
        error_code = payload.get("error_code")
        if not error_code and isinstance(data, dict):
            error_code = data.get("error_code") or data.get("error") or data.get("code")
        return LocalResponse(
            status=response.status_code,
            success=success,
            data=data,
            message=payload.get("message"),
            error_code=str(error_code) if error_code else None,
        )

    async def healthy(self) -> bool:
        try:
            response = await self.request("GET", "/api/v1/health/status")
            return response.status == 200 and response.success
        except Exception:  # noqa: BLE001
            return False

    async def aclose(self) -> None:
        await self._client.aclose()


@dataclass
class FlowServiceLease:
    mode: ServiceLeaseMode
    generation: ServiceGeneration
    client: LocalServiceClient


@contextmanager
def service_lifecycle_mutation():
    """Immediate guard for persistent start/stop mutations."""
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.instances.paths import service_lease_lock_path

    settings = get_instance_settings()
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(service_lease_lock_path(settings.instance_name)), timeout=0)
    try:
        lock.acquire()
    except Timeout as exc:
        raise FlowServiceError(
            "service_busy",
            f"Instance {settings.instance_name!r} is temporarily owned",
        ) from exc
    try:
        yield
    finally:
        if lock.is_locked:
            lock.release()


def _read_server_info(path: Path) -> tuple[dict[str, Any], bool]:
    if not path.exists():
        return {}, False
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}, True
    return (value, False) if isinstance(value, dict) else ({}, True)


def _pid_live(table, pid: Any) -> bool:
    return isinstance(pid, int) and table.owner_of(pid) is not None


def _strict_record_generation(settings, info: dict[str, Any], table) -> ServiceGeneration | None:
    pid = info.get("server_pid")
    port = info.get("port")
    if not isinstance(pid, int) or not isinstance(port, int) or port != settings.port:
        return None
    if table.ports_degraded or not table.adopt_server_json(settings.instance_name, pid, port):
        return None
    process = table.owner_of(pid)
    listeners = table.listeners(port)
    if process is None or process.instance != settings.instance_name or not listeners:
        return None
    if any(listener.instance != settings.instance_name for listener in listeners):
        return None
    create_time = process.create_time
    recorded_create_time = info.get("server_create_time")
    if create_time is None:
        return None
    if isinstance(recorded_create_time, (int, float)) and abs(create_time - recorded_create_time) > 1.0:
        return None
    generation = str(info.get("generation") or f"borrowed:{pid}:{create_time}")
    return ServiceGeneration(
        instance=settings.instance_name,
        pid=pid,
        create_time=create_time,
        port=port,
        generation=generation,
    )


def _singleton_is_free(path: Path) -> bool:
    lock = FileLock(str(path), timeout=0)
    try:
        lock.acquire()
    except Timeout:
        return False
    finally:
        if lock.is_locked:
            lock.release()
    return True


def _conclusively_down(settings, info: dict[str, Any], corrupt: bool, table) -> bool:
    if corrupt or table.ports_degraded:
        return False
    monitor_pid = info.get("monitor_pid")
    if _pid_live(table, monitor_pid):
        return False
    if table.listeners(settings.port):
        return False
    if any(proc.role and proc.role.value == "backend" for proc in table.owned_by(settings.instance_name)):
        return False
    recorded_pid = info.get("server_pid")
    if recorded_pid is not None and (not isinstance(recorded_pid, int) or _pid_live(table, recorded_pid)):
        return False
    return _singleton_is_free(settings.server_lock_path)


async def _run_migrations(env: dict[str, str], cwd: Path) -> int:
    """Run the canonical migration command and reap it on task cancellation."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "flow_sdk.cli.flow_cli",
        "migrate",
        "run",
        cwd=str(cwd),
        env=env,
    )
    try:
        return await process.wait()
    except asyncio.CancelledError:
        if process.returncode is None:
            process.terminate()
            await process.wait()
        raise


def _exact_cleanup(generation: ServiceGeneration) -> None:
    from flow_sdk.config import clear_server_info
    from flow_sdk.instances.liveness import ProcTable, scan
    from flow_sdk.instances.model import Role
    from flow_sdk.instances.procs import kill_owned

    table = scan(want_ports=True)
    if table.adopt_recorded(generation.instance, generation.pid, generation.create_time):
        process = table.owner_of(generation.pid)
        if process is not None and process.instance == generation.instance:
            # Listener readiness is deliberately not required: a child that
            # failed during startup is still our exact PID/create-time owner.
            exact_table = ProcTable(procs={generation.pid: process})
            kill_owned(
                generation.instance,
                exact_table,
                roles=frozenset({Role.BACKEND}),
                extra=[process],
            )
    # Independently clear only our exact record. This also cleans a stale
    # generation after the child has already died and vanished from the scan.
    clear_server_info(
        expected_pid=generation.pid,
        expected_create_time=generation.create_time,
        expected_generation=generation.generation,
    )


@asynccontextmanager
async def flow_service() -> AsyncIterator[FlowServiceLease]:
    """Borrow a healthy selected backend, or temporarily own one if down."""
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.instances import paths
    from flow_sdk.instances.env import build_named_instance_env
    from flow_sdk.instances.liveness import scan
    from flow_sdk.instances.procs import spawn_detached
    from flow_sdk.server.launch import wait_for_server_health

    settings = get_instance_settings()
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    table = scan(want_ports=True)
    info, corrupt = _read_server_info(settings.server_json_path)
    generation = _strict_record_generation(settings, info, table) if not corrupt else None
    if generation is not None:
        if info.get("generation"):
            # A generated backend belongs to the lease process holding the
            # lifecycle lock. Borrowing it would let that owner stop the server
            # underneath us when its own context exits.
            owner_lock = FileLock(str(paths.service_lease_lock_path(settings.instance_name)), timeout=0)
            try:
                owner_lock.acquire()
            except Timeout as exc:
                raise FlowServiceError(
                    "service_busy",
                    f"Instance {settings.instance_name!r} is temporarily owned",
                ) from exc
            finally:
                if owner_lock.is_locked:
                    owner_lock.release()
            raise FlowServiceError(
                "service_degraded",
                f"Instance {settings.instance_name!r} has an ownerless temporary generation",
            )
        client = LocalServiceClient(generation.port)
        if await client.healthy():
            try:
                yield FlowServiceLease(ServiceLeaseMode.BORROWED, generation, client)
            finally:
                await client.aclose()
            return
        await client.aclose()
        raise FlowServiceError(
            "service_degraded",
            f"Instance {settings.instance_name!r} has an owned listener that is not healthy",
        )

    if not _conclusively_down(settings, info, corrupt, table):
        raise FlowServiceError(
            "service_degraded",
            f"Instance {settings.instance_name!r} is not conclusively down; refusing to replace it",
        )

    # The lock is only the down→start ownership protocol. Healthy borrowed
    # clients remain concurrent while an interactive authorization is open.
    lifecycle_lock = FileLock(str(paths.service_lease_lock_path(settings.instance_name)), timeout=0)
    try:
        lifecycle_lock.acquire()
    except Timeout as exc:
        raise FlowServiceError(
            "service_busy",
            f"Instance {settings.instance_name!r} is already being started temporarily",
        ) from exc

    lease: FlowServiceLease | None = None
    try:
        # State may have changed between the optimistic classification and lock
        # acquisition. Reclassify from one new process-table snapshot.
        table = scan(want_ports=True)
        info, corrupt = _read_server_info(settings.server_json_path)
        generation = _strict_record_generation(settings, info, table) if not corrupt else None
        if generation is not None:
            if info.get("generation"):
                raise FlowServiceError(
                    "service_degraded",
                    f"Instance {settings.instance_name!r} changed to an ownerless temporary generation",
                )
            client = LocalServiceClient(generation.port)
            if not await client.healthy():
                await client.aclose()
                raise FlowServiceError(
                    "service_degraded",
                    f"Instance {settings.instance_name!r} became owned but is not healthy",
                )
            lifecycle_lock.release()
            try:
                yield FlowServiceLease(ServiceLeaseMode.BORROWED, generation, client)
            finally:
                await client.aclose()
            return

        if not _conclusively_down(settings, info, corrupt, table):
            raise FlowServiceError(
                "service_degraded",
                f"Instance {settings.instance_name!r} changed state; refusing to replace it",
            )

        generation_id = secrets.token_urlsafe(18)
        env = build_named_instance_env(settings, generation=generation_id)
        migration_exit = await _run_migrations(env, paths.repo_root())
        if migration_exit:
            raise FlowServiceError("migration_failed", f"Migration failed with exit {migration_exit}")

        # A standard backend owns its normal singleton lock. The lifecycle lock
        # prevents a second temporary owner while it is still booting.
        child = spawn_detached(
            [sys.executable, "-m", "flow_sdk.server.run"],
            env=env,
            log=settings.server_log_path,
            cwd=paths.repo_root(),
        )
        if child.pid is None or child.create_time is None:
            raise FlowServiceError("service_start_failed", "Backend process identity was not observable")
        generation = ServiceGeneration(
            instance=settings.instance_name,
            pid=child.pid,
            create_time=child.create_time,
            port=settings.port,
            generation=generation_id,
        )
        if not await asyncio.to_thread(wait_for_server_health, settings.port):
            await asyncio.to_thread(_exact_cleanup, generation)
            raise FlowServiceError("service_start_failed", "Temporary backend did not become healthy")

        started_info, started_corrupt = _read_server_info(settings.server_json_path)
        started_table = scan(want_ports=True)
        observed = _strict_record_generation(settings, started_info, started_table) if not started_corrupt else None
        if observed != generation:
            await asyncio.to_thread(_exact_cleanup, generation)
            raise FlowServiceError(
                "service_generation_mismatch",
                "The healthy backend is not the temporary generation that was started",
            )
        client = LocalServiceClient(generation.port)
        lease = FlowServiceLease(ServiceLeaseMode.OWNED, generation, client)
        yield lease
    finally:
        if lease is not None:
            await lease.client.aclose()
            if lease.mode == ServiceLeaseMode.OWNED:
                await asyncio.to_thread(_exact_cleanup, lease.generation)
        if lifecycle_lock.is_locked:
            lifecycle_lock.release()
