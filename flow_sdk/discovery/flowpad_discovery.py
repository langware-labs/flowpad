#!/usr/bin/env python3
"""
Flowpad Discovery Module

Discovers the running Flowpad server via port file and health check.
Provides three-state detection: running, installed-not-running, not-installed.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

FLOWPAD_APP_NAME = "FlowPad"

# Rate limiting constants
MAX_FAILURES_PER_HOUR = 3
HOUR_IN_SECONDS = 3600


def _server_json_path() -> Path:
    """Resolve the active server.json via the per-instance settings."""
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().server_json_path


@dataclass
class FlowpadServerInfo:
    """Server connection information from port file.

    Note this is a *different* type from ``flow_sdk.config.FlowpadServerInfo``
    (a pydantic model that writes the file); this one is the read side and
    carries only what discovery consumers need.
    """

    port: int
    webhook_path: str
    health_path: str
    url: str  # Computed: http://localhost:{port}{webhook_path}
    #: Optional: absent from files written by older servers. Used to tell a
    #: live entry from one left behind by a crashed backend.
    server_pid: Optional[int] = None


class FlowpadStatus:
    """Status constants for Flowpad discovery result."""

    RUNNING = "running"
    INSTALLED_NOT_RUNNING = "installed_not_running"
    NOT_INSTALLED = "not_installed"


@dataclass
class FlowpadDiscoveryResult:
    """Result of Flowpad discovery."""

    status: str
    server_info: Optional[FlowpadServerInfo] = None
    error: Optional[str] = None


def _parse_server_json(path: Path) -> Optional[FlowpadServerInfo]:
    """Read one server.json and return its info, or None if missing/corrupt."""
    try:
        data = json.loads(path.read_text())
        try:
            server_pid = int(data["server_pid"])
        except (KeyError, TypeError, ValueError):
            server_pid = None
        return FlowpadServerInfo(
            port=data["port"],
            webhook_path=data["webhook_path"],
            health_path=data["health_path"],
            url=f"http://localhost:{data['port']}{data['webhook_path']}",
            server_pid=server_pid,
        )
    except (json.JSONDecodeError, KeyError, OSError):
        return None


class _ServerState:
    """Cached server state with rate-limited failure tracking."""

    def __init__(self, path: Path):
        self._path = path
        self._discovery_result: Optional[FlowpadDiscoveryResult] = None
        self._port_file_mtime: Optional[float] = None
        self._failure_timestamps: list[float] = []

    def _get_port_file_mtime(self) -> Optional[float]:
        """Get modification time of port file, or None if not exists."""
        try:
            return self._path.stat().st_mtime
        except OSError:
            return None

    def _read_server_info(self) -> Optional[FlowpadServerInfo]:
        """Read this state's JSON file and return FlowpadServerInfo if valid."""
        return _parse_server_json(self._path)

    def _discover(self) -> FlowpadDiscoveryResult:
        """Internal discovery using this state's path."""
        server_info = self._read_server_info()

        if server_info:
            if check_server_health(server_info):
                return FlowpadDiscoveryResult(
                    status=FlowpadStatus.RUNNING,
                    server_info=server_info,
                )
            return FlowpadDiscoveryResult(
                status=FlowpadStatus.INSTALLED_NOT_RUNNING,
                error="Server not responding",
            )

        if is_flowpad_installed():
            return FlowpadDiscoveryResult(
                status=FlowpadStatus.INSTALLED_NOT_RUNNING,
                error="App installed but not running",
            )

        return FlowpadDiscoveryResult(status=FlowpadStatus.NOT_INSTALLED)

    def _is_cache_valid(self) -> bool:
        """Check if cached result is still valid."""
        if self._discovery_result is None:
            return False
        # Don't cache negative results: if the previous discovery couldn't
        # confirm the server is running, always retry. Otherwise a startup
        # race (server.json written before health endpoint binds) poisons
        # the cache permanently — the mtime never changes again, so the
        # cache stays valid and notifications get silently dropped forever.
        if self._discovery_result.status != FlowpadStatus.RUNNING:
            return False
        # Invalidate if port file changed
        current_mtime = self._get_port_file_mtime()
        if current_mtime != self._port_file_mtime:
            return False
        # Invalidate if rate-limited (re-check if server came back)
        if self.is_rate_limited():
            return False
        return True

    def get_discovery_result(self) -> FlowpadDiscoveryResult:
        """Get discovery result, re-discovering if cache is invalid."""
        if not self._is_cache_valid():
            self._discovery_result = self._discover()
            self._port_file_mtime = self._get_port_file_mtime()
            # Clear failures on successful re-discovery if server is running
            if self._discovery_result.status == FlowpadStatus.RUNNING:
                self._failure_timestamps = []
        return self._discovery_result

    def record_webhook_failure(self) -> None:
        """Record a webhook failure timestamp."""
        now = time.time()
        self._failure_timestamps.append(now)
        # Keep only failures from the last hour
        cutoff = now - HOUR_IN_SECONDS
        self._failure_timestamps = [t for t in self._failure_timestamps if t > cutoff]

    def is_rate_limited(self) -> bool:
        """Check if we've exceeded failure limit (3 failures in the last hour).

        Clears failures if port file changed (server may have restarted).
        """
        # If port file changed, clear failures - server may have restarted
        current_mtime = self._get_port_file_mtime()
        if current_mtime != self._port_file_mtime:
            self._failure_timestamps = []
            return False

        now = time.time()
        cutoff = now - HOUR_IN_SECONDS
        recent_failures = [t for t in self._failure_timestamps if t > cutoff]
        return len(recent_failures) >= MAX_FAILURES_PER_HOUR


# Per-path cached states — one per server.json file path. Lazy so the path is
# resolved through InstanceSettings only after .env.local has been loaded.
_states: dict[Path, "_ServerState"] = {}


def _active_state() -> _ServerState:
    path = _server_json_path()
    state = _states.get(path)
    if state is None:
        state = _ServerState(path)
        _states[path] = state
    return state


def get_port_file_path() -> Path:
    """Get path to active server JSON file (dev or prod)."""
    return _active_state()._path


def write_server_info(
    port: int,
    webhook_path: str = "/api/v1/webhook/listen",
    health_path: str = "/api/v1/health/status",
) -> Path:
    """Write server.json with connection info for external tools.

    Args:
        port: The port the server is running on.
        webhook_path: Webhook endpoint path (default: /api/v1/webhook/listen).
        health_path: Health check endpoint path (default: /api/v1/health/status).

    Returns:
        Path to the written server.json file.
    """
    port_file = get_port_file_path()
    port_file.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "port": port,
        "webhook_path": webhook_path,
        "health_path": health_path,
    }
    port_file.write_text(json.dumps(data, indent=2))
    return port_file


def read_server_info() -> Optional[FlowpadServerInfo]:
    """Read the active server JSON and return info if valid.

    Returns:
        FlowpadServerInfo if port file exists and is valid, None otherwise.
    """
    return _active_state()._read_server_info()


class InstanceNotRunningError(RuntimeError):
    """The FLOW_INSTANCE-selected instance has no live ``server.json``.

    Carries the instance name + path so CLI callers can surface a clear
    message instead of silently dialing a port nothing is listening on.
    """

    def __init__(self, instance_name: str, server_json_path: Path):
        self.instance_name = instance_name
        self.server_json_path = server_json_path
        super().__init__(
            f"Instance '{instance_name}' is not running "
            f"(no server.json at {server_json_path}) — start it or set FLOW_INSTANCE."
        )


def resolve_cli_port() -> int:
    """Resolve the port the ``flow`` CLI should target for the active instance.

    The instance is FLOW_INSTANCE-aware (via ``get_instance_settings``); the
    port comes from that instance's ``server.json``. Single chokepoint shared
    by every ``flow`` subcommand so instance selection stays consistent.

    Raises:
        InstanceNotRunningError: when the selected instance has no live
            ``server.json`` (i.e. it isn't running).
    """
    info = read_server_info()
    if info is not None:
        return info.port
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    settings = get_instance_settings()
    raise InstanceNotRunningError(settings.instance_name, settings.server_json_path)


def check_server_health(server_info: FlowpadServerInfo, timeout: float = 2.0) -> bool:
    """Check if server is running via health endpoint.

    Args:
        server_info: Server connection info from port file.
        timeout: Request timeout in seconds.

    Returns:
        True if health check succeeds (HTTP 200), False otherwise.
    """
    health_url = f"http://localhost:{server_info.port}{server_info.health_path}"
    try:
        req = urllib.request.Request(health_url, method="GET")
        # Carry the cookie-gate secret when this instance is armed. Without it a
        # gated server refuses the probe -- the gate has NO path exemptions and
        # `/health/status` is explicitly included -- and a 403 is
        # indistinguishable from a dead server from here, so a perfectly healthy
        # instance reads as down. Same reasoning, and the same header transport,
        # as `server.launch.check_server_health`.
        from flow_sdk.instance_settings.cookie_gate import gate_headers

        for name, value in gate_headers(health_url).items():
            req.add_header(name, value)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return False


def is_flowpad_installed() -> bool:
    """Check if Flowpad app is installed.

    Returns:
        True if Flowpad appears to be installed, False otherwise.
    """
    if sys.platform == "darwin":
        paths = [
            Path("/Applications") / f"{FLOWPAD_APP_NAME}.app",
            Path.home() / "Applications" / f"{FLOWPAD_APP_NAME}.app",
        ]
    elif sys.platform == "win32":
        program_files = os.getenv("ProgramFiles", "C:\\Program Files")
        local_appdata = os.getenv("LOCALAPPDATA", "")
        paths = [
            Path(program_files) / FLOWPAD_APP_NAME / f"{FLOWPAD_APP_NAME}.exe",
            Path(local_appdata) / "Programs" / FLOWPAD_APP_NAME / f"{FLOWPAD_APP_NAME}.exe",
        ]
    else:
        # Linux
        paths = [
            Path.home() / ".local" / "share" / "applications" / f"{FLOWPAD_APP_NAME}.desktop",
            Path(f"/usr/share/applications/{FLOWPAD_APP_NAME}.desktop"),
            Path(f"/usr/bin/{FLOWPAD_APP_NAME}"),
        ]
    return any(p.exists() for p in paths)


def discover_flowpad() -> FlowpadDiscoveryResult:
    """Get cached Flowpad discovery result for the active server (dev or prod).

    Health check is performed once on first call (startup).
    Subsequent calls return the cached result.

    Returns:
        Cached FlowpadDiscoveryResult.
    """
    return _active_state().get_discovery_result()


def record_webhook_failure() -> None:
    """Record a webhook failure for rate limiting."""
    _active_state().record_webhook_failure()


def is_webhook_rate_limited() -> bool:
    """Check if webhooks are rate-limited due to repeated failures.

    Returns:
        True if 3+ failures occurred in the last hour.
    """
    return _active_state().is_rate_limited()


def _enumerate_server_json_paths() -> list[Path]:
    """Return ``server.json`` paths for every instance under ``<flow_home>/instances/``.
    Enumeration (vs. a hardcoded prod+dev pair) keeps oss/app instances visible to a
    CLI subprocess invoked without FLOW_INSTANCE.
    """
    from flow_sdk.instance_settings import BaseInstanceSettings

    flow_home = BaseInstanceSettings._resolve_flow_home()
    instances_root = flow_home / "instances"
    if not instances_root.is_dir():
        return []
    paths: list[Path] = []
    for instance_dir in instances_root.iterdir():
        if not instance_dir.is_dir():
            continue
        sj = instance_dir / "server.json"
        if sj.exists():
            paths.append(sj)
    return paths


def _server_pid_is_alive(pid: int | None) -> bool:
    """Is this server.json's recorded backend still running?

    ``pid_probe`` rather than psutil: this is on the hook-broadcast path, which
    must stay import-cheap and must never raise. It is emphatically NOT
    ``os.kill(pid, 0)``, which this function used to call — on Windows that
    sends the caller's own console a Ctrl-C instead of probing anything, so
    enumerating instances here shut the enumerating backend down.
    """
    from flow_sdk.pid_probe import pid_is_alive

    return pid_is_alive(pid)


def read_all_server_infos() -> list[FlowpadServerInfo]:
    """Read every instance's server JSON file, return the LIVE entries.

    Fast path — no health check. Skips missing or corrupt files.

    Two filters, and the order matters:

    1. **Dead-PID filter.** ``clear_server_info`` only runs on a graceful
       uvicorn shutdown, so a SIGKILL, a crash or a closed laptop leaves the
       file behind; one developer machine had 27 such files against a single
       live backend. A stale entry is not inert — ``flow hooks report`` POSTs to
       every server.json it is handed, so once the port band recycles, a dead
       instance's file delivers hook payloads into a live, unrelated backend.
       Filtering on the recorded PID removes the entry at the source rather than
       relying on the port-dedupe below to mask it.

       Entries with no recorded ``server_pid`` are kept: older writers omitted
       it, and dropping them would silently stop notifying a real backend.

    2. **Port dedupe.** Only one server can own a port, so a second *live-looking*
       file claiming the same port is still a leftover. Live entries are
       preferred over pid-less ones when both claim a port.

    Returns:
        List of FlowpadServerInfo, one per distinct port.
    """
    by_port: dict[int, FlowpadServerInfo] = {}
    pidless: list[FlowpadServerInfo] = []
    for path in _enumerate_server_json_paths():
        info = _parse_server_json(path)
        if info is None:
            continue
        if info.server_pid is None:
            pidless.append(info)
            continue
        if not _server_pid_is_alive(info.server_pid):
            continue
        by_port[info.port] = info
    for info in pidless:
        by_port.setdefault(info.port, info)
    return list(by_port.values())


def discover_all_flowpads() -> list[FlowpadDiscoveryResult]:
    """Run health-checked discovery against every instance state.

    Returns:
        List of FlowpadDiscoveryResult with status RUNNING only.
    """
    results = []
    for path in _enumerate_server_json_paths():
        state = _states.get(path) or _ServerState(path)
        _states[path] = state
        r = state.get_discovery_result()
        if r.status == FlowpadStatus.RUNNING:
            results.append(r)
    return results


if __name__ == "__main__":
    # CLI interface for testing. Pre-existing prints; noqa'd rather than
    # rewritten because staging this file for an unrelated fix is the first
    # time pre-commit has ever linted it, and a debug __main__ block is where
    # print is the right call.
    result = discover_flowpad()
    print(f"Status: {result.status}")  # noqa: T201
    if result.server_info:
        print(f"Server URL: {result.server_info.url}")  # noqa: T201
        print(f"Health URL: http://localhost:{result.server_info.port}{result.server_info.health_path}")  # noqa: T201
    if result.error:
        print(f"Error: {result.error}")  # noqa: T201
