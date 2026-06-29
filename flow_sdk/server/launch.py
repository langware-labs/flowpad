#!/usr/bin/env python3
"""Server launcher & monitor for flow-cli.

Keeps the minihub server alive in the background, restarts on crash,
and writes process info to ~/.flow/server.json for discovery by CLI,
hooks, and external tools.

Usage:
    python -m flow_sdk.server.launch [port]
"""

import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil

from flow_sdk.service_log import cleanup_old_logs, generate_timestamped_log_path


def _logs_base() -> Path:
    """Lazy logs-dir lookup via per-instance settings."""
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().logs_dir

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Marker substring used to validate that a PID actually belongs to our
# server / monitor (guards against recycled PIDs).
_SERVER_CMD_MARKER = "flow_sdk.server"
_MONITOR_CMD_MARKER = "flow_sdk.server.launch"


# ---------------------------------------------------------------------------
# Logging (module-level logger, configured in launch_monitor)
# ---------------------------------------------------------------------------

log = logging.getLogger("flow.monitor")


def _setup_logging() -> None:
    """Configure timestamped file + stderr logging for the monitor process."""

    monitor_log_dir = _logs_base() / "monitor"
    cleanup_old_logs(monitor_log_dir)
    monitor_log_path = generate_timestamped_log_path("monitor")

    handler = logging.FileHandler(str(monitor_log_path), encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    log.addHandler(handler)
    log.addHandler(logging.StreamHandler(sys.stderr))
    log.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Process utilities
# ---------------------------------------------------------------------------

def is_process_alive(pid: int, expected_name: str | None = None) -> bool:
    """Check if *pid* is alive and optionally contains *expected_name* in cmdline.

    Guards against recycled PIDs by inspecting the command line.
    """
    try:
        proc = psutil.Process(pid)
        if proc.status() == psutil.STATUS_ZOMBIE:
            return False
        if expected_name is not None:
            cmdline = " ".join(proc.cmdline())
            if expected_name not in cmdline:
                return False
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False


def kill_process(pid: int, timeout: float = 5.0) -> bool:
    """SIGTERM → wait → SIGKILL.  Returns True if process was terminated."""
    try:
        proc = psutil.Process(pid)
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except psutil.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except psutil.TimeoutExpired:
                log.warning("Process PID=%d did not exit after SIGKILL", pid)
                return False
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False


def start_detached_process(args: list[str], env: dict | None = None, stderr=None) -> int:
    """Launch a fully detached subprocess that survives parent exit.

    Returns the child PID.
    """
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": stderr if stderr is not None else subprocess.DEVNULL,
        "env": env or os.environ.copy(),
    }
    if sys.platform == "win32":
        CREATE_NO_WINDOW = 0x08000000
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        kwargs["creationflags"] = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(args, **kwargs)
    return proc.pid


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------

def check_server_health(port: int, timeout: float = 2.0) -> bool:
    """GET http://127.0.0.1:{port}/api/v1/health/status → 200?"""
    import urllib.request
    import urllib.error

    url = f"http://127.0.0.1:{port}/health/status"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def start_server_process(port: int) -> int:
    """Start the minihub server as a detached process. Returns PID."""

    env = os.environ.copy()
    env["LOCAL_SERVER_PORT"] = str(port)

    server_log_dir = _logs_base() / "server"
    cleanup_old_logs(server_log_dir)
    server_log_path = generate_timestamped_log_path("server")

    server_log = open(server_log_path, "a")  # noqa: WPS515 — fd inherited by child
    args = [sys.executable, "-m", "flow_sdk.server.run"]
    pid = start_detached_process(args, env=env, stderr=server_log)
    server_log.close()
    log.info("Started server process PID=%d on port %d (stderr → %s)", pid, port, server_log_path)
    return pid


def wait_for_server_health(port: int, timeout: float = 10.0) -> bool:
    """Poll health endpoint every 0.5s until success or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check_server_health(port, timeout=1.0):
            return True
        time.sleep(0.5)
    return False


# ---------------------------------------------------------------------------
# Server info helpers (thin wrappers around config.py)
# ---------------------------------------------------------------------------

def _load_info() -> dict:
    from flow_sdk.config import load_server_info
    return load_server_info()


def _save_info(data: dict) -> None:
    from flow_sdk.config import save_server_info
    save_server_info(data)


# ---------------------------------------------------------------------------
# Monitor core
# ---------------------------------------------------------------------------

def _is_ancestor(pid: int) -> bool:
    """Check if *pid* is an ancestor of the current process.

    On Windows, .venv/Scripts/python.exe is a trampoline launcher that spawns
    the real Python interpreter as a child.  Popen.pid returns the trampoline
    PID, but os.getpid() returns the real child PID.  We must never kill our
    own ancestor — it would cascade and kill us.
    """
    try:
        current = psutil.Process()
        for parent in current.parents():
            if parent.pid == pid:
                return True
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return False


def ensure_monitor_singleton(server_info: dict) -> dict:
    """Kill any stale monitor and claim the monitor_pid slot."""
    old_pid = server_info.get("monitor_pid")
    if old_pid and old_pid != os.getpid() and not _is_ancestor(old_pid):
        if is_process_alive(old_pid, expected_name=_MONITOR_CMD_MARKER):
            log.info("Killing old monitor PID=%d", old_pid)
            kill_process(old_pid)
    elif old_pid and _is_ancestor(old_pid):
        log.info("Old monitor PID=%d is our ancestor (trampoline), skipping kill", old_pid)

    server_info["monitor_pid"] = os.getpid()
    server_info["launch_iso_time"] = datetime.now(timezone.utc).isoformat()
    server_info.setdefault("server_pid", None)  # always present so flow status output is unambiguous
    _save_info(server_info)
    return server_info


def monitor_loop(port: int, interval: float = 30.0) -> None:
    """Infinite loop: sleep → health check → restart if needed."""
    consecutive_failures = 0
    restart_failure_threshold = 3
    max_backoff = 300.0  # 5 minutes
    last_resource_log = 0.0

    while True:
        # Sleep with backoff
        if consecutive_failures >= 3:
            backoff = min(2 ** consecutive_failures, max_backoff)
            log.warning("Backoff: sleeping %.1fs after %d failures", backoff, consecutive_failures)
            time.sleep(backoff)
        else:
            time.sleep(interval)

        # Log resource usage every 10 minutes
        now = time.monotonic()
        if now - last_resource_log >= 600.0:
            try:
                info = _load_info()
                server_pid = info.get("server_pid")
                if server_pid and is_process_alive(server_pid):
                    proc = psutil.Process(server_pid)
                    cpu = proc.cpu_percent(interval=0.2)
                    mem_mb = proc.memory_info().rss / (1024 * 1024)
                    log.info("Server PID=%d | CPU=%.1f%% | RSS=%.1fMB", server_pid, cpu, mem_mb)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            last_resource_log = now

        if check_server_health(port):
            if consecutive_failures > 0:
                log.info("Server recovered after %d failures", consecutive_failures)
            consecutive_failures = 0
            continue

        consecutive_failures += 1
        log.warning("Health check failed (attempt %d)", consecutive_failures)

        info = _load_info()
        server_pid = info.get("server_pid")

        if server_pid and is_process_alive(server_pid, expected_name=_SERVER_CMD_MARKER):
            if consecutive_failures < restart_failure_threshold:
                log.warning(
                    "Server PID=%d alive but health check failed — waiting for %d consecutive failures before restart",
                    server_pid,
                    restart_failure_threshold,
                )
                continue

            log.warning("Server PID=%d alive but unhealthy — killing", server_pid)
            kill_process(server_pid)
            time.sleep(1)

        # Restart server
        new_pid = start_server_process(port)
        info["server_pid"] = new_pid
        _save_info(info)

        if wait_for_server_health(port, timeout=10.0):
            log.info("Server restarted successfully (PID=%d)", new_pid)
            consecutive_failures = 0
        else:
            log.error("Server failed to become healthy after restart (PID=%d)", new_pid)


def launch_monitor(port: int) -> None:
    """Main entry point — runs IN the monitor process."""
    _setup_logging()
    log.info("Monitor starting (PID=%d, port=%d)", os.getpid(), port)

    try:
        info = _load_info()
        info.setdefault("port", port)
        log.info("Loaded server info: monitor_pid=%s, server_pid=%s", info.get("monitor_pid"), info.get("server_pid"))
        info = ensure_monitor_singleton(info)
        log.info("Singleton claimed, checking server health...")

        # Check if server is already healthy
        if check_server_health(port):
            log.info("Server already healthy on port %d", port)
        else:
            # Kill any stale server process before starting a fresh one; this
            # frees the port on Windows where TIME_WAIT can block a new bind.
            server_pid = info.get("server_pid")
            if server_pid and is_process_alive(server_pid, expected_name=_SERVER_CMD_MARKER):
                log.warning("Killing stale server PID=%d before restart", server_pid)
                kill_process(server_pid)
                time.sleep(1)  # allow port to release

            new_pid = start_server_process(port)
            info["server_pid"] = new_pid
            _save_info(info)

            if not wait_for_server_health(port, timeout=15.0):
                log.error("Server did not become healthy within 15s (check %s)", _logs_base() / "server")

            log.info("Entering monitor loop...")
            monitor_loop(port)
    except Exception:
        log.exception("Monitor crashed with unhandled exception")
        raise


# ---------------------------------------------------------------------------
# CLI helpers (called from flow_cli.py)
# ---------------------------------------------------------------------------

def start_monitor_detached(port: int) -> int:
    """Launch the monitor as a detached process. Returns monitor PID.

    NOTE: On Windows, Popen.pid returns the launcher/trampoline PID, not the
    actual Python process PID.  The monitor writes its own real PID via
    ensure_monitor_singleton() once it starts.  We intentionally do NOT write
    monitor_pid here to avoid the singleton guard killing the launcher (which
    cascades and kills the real monitor).
    """
    args = [sys.executable, "-m", "flow_sdk.server.launch", str(port)]
    pid = start_detached_process(args)

    # Write port + launch time so CLI can discover the server,
    # but leave monitor_pid for the monitor to set itself.
    from flow_sdk.config import set_server_info
    set_server_info({
        "port": port,
        "monitor_pid": pid,
        "launch_iso_time": datetime.now(timezone.utc).isoformat(),
    })

    return pid


def stop_all() -> tuple[bool, bool]:
    """Kill monitor + server from flow_sdk.server.json. Returns (monitor_killed, server_killed)."""
    info = _load_info()
    monitor_killed = False
    server_killed = False

    monitor_pid = info.get("monitor_pid")
    if monitor_pid and is_process_alive(monitor_pid, expected_name=_MONITOR_CMD_MARKER):
        monitor_killed = kill_process(monitor_pid)

    server_pid = info.get("server_pid")
    if server_pid and is_process_alive(server_pid, expected_name=_SERVER_CMD_MARKER):
        server_killed = kill_process(server_pid)

    # Clear PIDs from server.json
    from flow_sdk.config import clear_server_info
    clear_server_info()

    return monitor_killed, server_killed


def get_status() -> dict:
    """Return dict with monitor/server alive booleans, health, PIDs."""
    info = _load_info()
    port = info.get("port", 9007)
    monitor_pid = info.get("monitor_pid")
    server_pid = info.get("server_pid")

    return {
        "port": port,
        "monitor_pid": monitor_pid,
        "monitor_alive": bool(monitor_pid and is_process_alive(monitor_pid, expected_name=_MONITOR_CMD_MARKER)),
        "server_pid": server_pid,
        "server_alive": bool(server_pid and is_process_alive(server_pid, expected_name=_SERVER_CMD_MARKER)),
        "server_healthy": check_server_health(port),
        "launch_iso_time": info.get("launch_iso_time"),
    }


# ---------------------------------------------------------------------------
# __main__ — allows `python -m flow_sdk.server.launch [port]`
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9007
    try:
        launch_monitor(port)
    except Exception:
        _setup_logging()
        log.exception("Monitor crashed with unhandled exception")
        raise
