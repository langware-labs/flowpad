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
    """Server connection information from port file."""

    port: int
    webhook_path: str
    health_path: str
    url: str  # Computed: http://localhost:{port}{webhook_path}


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
        if not self._path.exists():
            return None
        try:
            data = json.loads(self._path.read_text())
            return FlowpadServerInfo(
                port=data["port"],
                webhook_path=data["webhook_path"],
                health_path=data["health_path"],
                url=f"http://localhost:{data['port']}{data['webhook_path']}",
            )
        except (json.JSONDecodeError, KeyError, OSError):
            return None

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


def read_all_server_infos() -> list[FlowpadServerInfo]:
    """Read both prod and dev server JSON files, return all valid entries.

    Fast path — no health check. Skips missing or corrupt files.

    Returns:
        List of FlowpadServerInfo for all currently written server files.
    """
    # Discovery enumerates BOTH instances by design (cross-mode discovery).
    # Resolve the canonical paths via the per-instance settings classes.
    from flow_sdk.instance_settings import (
        BaseInstanceSettings,
        DevInstanceSettings,
    )
    candidate_paths = [
        BaseInstanceSettings.from_env().server_json_path,
        DevInstanceSettings.from_env().server_json_path,
    ]

    infos = []
    for path in candidate_paths:
        try:
            data = json.loads(path.read_text())
            infos.append(FlowpadServerInfo(
                port=data["port"],
                webhook_path=data["webhook_path"],
                health_path=data["health_path"],
                url=f"http://localhost:{data['port']}{data['webhook_path']}",
            ))
        except Exception:
            pass
    return infos


def discover_all_flowpads() -> list[FlowpadDiscoveryResult]:
    """Run health-checked discovery against both prod and dev states.

    Returns:
        List of FlowpadDiscoveryResult with status RUNNING only.
    """
    from flow_sdk.instance_settings import (
        BaseInstanceSettings,
        DevInstanceSettings,
    )
    candidate_paths = [
        BaseInstanceSettings.from_env().server_json_path,
        DevInstanceSettings.from_env().server_json_path,
    ]
    results = []
    for path in candidate_paths:
        state = _states.get(path) or _ServerState(path)
        _states[path] = state
        r = state.get_discovery_result()
        if r.status == FlowpadStatus.RUNNING:
            results.append(r)
    return results


if __name__ == "__main__":
    # CLI interface for testing
    result = discover_flowpad()
    print(f"Status: {result.status}")
    if result.server_info:
        print(f"Server URL: {result.server_info.url}")
        print(f"Health URL: http://localhost:{result.server_info.port}{result.server_info.health_path}")
    if result.error:
        print(f"Error: {result.error}")
