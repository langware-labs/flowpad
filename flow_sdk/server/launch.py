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
from filelock import FileLock

from flow_sdk import singleton_lock
from flow_sdk.instance_settings.base_settings import DEFAULT_PROD_PORT
from flow_sdk.server.memory_probe import memory_snapshot
from flow_sdk.service_log import cleanup_old_logs, generate_timestamped_log_path


def _logs_base() -> Path:
    """Lazy logs-dir lookup via per-instance settings."""
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().logs_dir


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Marker substrings used to validate that a PID actually belongs to our
# server / monitor (guards against recycled PIDs). The server marker is the
# full module name on purpose: a bare "flow_sdk.server" is a prefix of the
# monitor's own cmdline, so the monitor would pass the *server* check and
# could be killed, or restarted around, as if it were the backend.
_SERVER_CMD_MARKER = "flow_sdk.server.run"
_MONITOR_CMD_MARKER = "flow_sdk.server.launch"

# The backend this monitor spawned, retained so it can be polled and reaped.
# Without this the Popen is dropped and every exited child (a crash, or a
# backend that lost the server singleton lock) lingers as a zombie for the
# monitor's lifetime -- and a zombie pid still probes as "alive" to the
# stdlib pid check that discovery uses.
_server_child: subprocess.Popen | None = None

# Held for the monitor's lifetime; see acquire_monitor_singleton.
_monitor_lock: FileLock | None = None


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


def start_detached_process(args: list[str], env: dict | None = None, stderr=None) -> subprocess.Popen:
    """Launch a fully detached subprocess that survives parent exit.

    Returns the Popen so a long-lived parent can poll and reap it.
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

    return subprocess.Popen(args, **kwargs)


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------


def check_server_health(port: int, timeout: float = 2.0) -> bool:
    """GET http://127.0.0.1:{port}/health/status → 200?

    Carries the cookie-gate secret when this instance is gated. Without it the
    monitor is refused like any other keyless caller -- the gate has NO path
    exemptions, `/health/status` explicitly included -- and a 403 is
    indistinguishable from a dead server down here. The monitor then kills a
    perfectly healthy app, the replacement is refused for the same reason, and
    the instance restart-loops forever with a doubling backoff. That is not
    hypothetical: it is what every gated sandbox did until this line existed,
    silently destroying agent turns, terminals and pending device logins on
    every cycle.

    The HEADER transport, not the query param: `cookie_gate_middleware` lists it
    as the one for machine callers, and a secret in a URL lands in access logs.

    Free when ungated -- `get_cookie_gate` answers from a `stat()` of the marker
    file and never opens the encrypted store, which is what keeps desktop
    installs (never gated) away from a keychain prompt. Any failure to read it
    resolves to None, so the check degrades to exactly its old behaviour rather
    than erroring.
    """
    import urllib.error
    import urllib.request

    url = f"http://127.0.0.1:{port}/health/status"
    try:
        req = urllib.request.Request(url, method="GET")
        # Lazy: `gate_headers` pulls in starlette on the armed path, and this
        # supervisor otherwise never needs it and must not pay for it at
        # startup. It swallows its own failures and yields {} -- the monitor
        # must survive anything the settings layer does, since being unable to
        # read the gate is a reason to probe without it, never a reason to stop
        # supervising the server.
        from flow_sdk.instance_settings.cookie_gate import gate_headers

        for name, value in gate_headers(url).items():
            req.add_header(name, value)
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except urllib.error.HTTPError as e:
        # Distinguished from "no answer" on purpose. A gated instance that
        # refuses the monitor looks exactly like a crashed one from here, and
        # the only difference visible anywhere is this status code -- so it gets
        # said out loud rather than folded into a bare False.
        log.warning("Health check rejected with HTTP %s (gated instance without the secret?)", e.code)
        return False
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
    global _server_child
    _server_child = start_detached_process(args, env=env, stderr=server_log)
    server_log.close()
    log.info("Started server process PID=%d on port %d (stderr → %s)", _server_child.pid, port, server_log_path)
    return _server_child.pid


def _reap_server_child() -> None:
    """Collect the spawned backend if it has exited, so it never lingers as a zombie."""
    global _server_child
    if _server_child is not None and (rc := _server_child.poll()) is not None:
        log.warning("Server child PID=%d exited with code %s", _server_child.pid, rc)
        _server_child = None


def _live_server_pid() -> int | None:
    """The backend to supervise right now, or None if nothing is running.

    ``server_pid`` is read fresh from disk: the backend is its only writer, so
    the file names whichever process holds the server singleton lock, not
    merely the one this monitor last spawned. A child still booting has not
    written the file yet, so a running child is the fallback.
    """
    pid = _load_info().get("server_pid")
    if pid and is_process_alive(pid, expected_name=_SERVER_CMD_MARKER):
        return pid
    if _server_child is not None and _server_child.poll() is None:
        return _server_child.pid
    return None


def _kill_server(pid: int) -> bool:
    """``kill_process``, then reap *pid* if it is the child this monitor spawned."""
    killed = kill_process(pid)
    if _server_child is not None and _server_child.pid == pid:
        _reap_server_child()
    return killed


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


def _set_info(data: dict) -> None:
    """Merge *data* into server.json. The backend writes ``server_pid``,
    ``server_create_time`` and ``generation`` itself; a whole-file save from a
    stale snapshot would erase them, so the monitor only ever merges."""
    from flow_sdk.config import set_server_info

    set_server_info(data)


# ---------------------------------------------------------------------------
# Monitor singleton lock
# ---------------------------------------------------------------------------


def _monitor_lock_paths() -> tuple[Path, Path]:
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    return settings.monitor_lock_path, settings.monitor_pid_path


def _monitor_is_alive(pid: int) -> bool:
    return is_process_alive(pid, expected_name=_MONITOR_CMD_MARKER)


def acquire_monitor_singleton() -> bool:
    """Take the per-instance monitor lock, or report that another monitor holds it.

    The same protocol as the backend's (``flow_sdk.singleton_lock``): this is
    what keeps two monitors -- from any launcher, whether or not server.json
    names them -- from supervising one port and racing each other's backends.
    ``FLOWPAD_SKIP_LOCK=true`` bypasses it, as it does for the server.
    """
    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        log.info("Monitor lock skipped (FLOWPAD_SKIP_LOCK=true)")
        return True

    global _monitor_lock
    lock_path, pid_path = _monitor_lock_paths()
    _monitor_lock = singleton_lock.acquire(lock_path, pid_path, _monitor_is_alive, log, "Monitor")
    return _monitor_lock is not None


def _release_monitor_lock() -> None:
    global _monitor_lock
    singleton_lock.release(_monitor_lock, _monitor_lock_paths()[1])
    _monitor_lock = None


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


def ensure_monitor_singleton(port: int) -> None:
    """Kill a pre-lock monitor that server.json still names, then record ourselves."""
    info = _load_info()
    old_pid = info.get("monitor_pid")
    log.info("Loaded server info: monitor_pid=%s, server_pid=%s", old_pid, info.get("server_pid"))
    if old_pid and old_pid != os.getpid():
        if _is_ancestor(old_pid):
            log.info("Old monitor PID=%d is our ancestor (trampoline), skipping kill", old_pid)
        elif _monitor_is_alive(old_pid):
            log.info("Killing old monitor PID=%d", old_pid)
            kill_process(old_pid)

    _set_info(
        {
            "port": port,
            "monitor_pid": os.getpid(),
            "launch_iso_time": datetime.now(timezone.utc).isoformat(),
        }
    )


def monitor_loop(port: int, interval: float = 30.0) -> None:
    """Infinite loop: sleep → health check → restart if needed."""
    consecutive_failures = 0
    restart_failure_threshold = 3
    max_backoff = 300.0  # 5 minutes
    last_resource_log = 0.0

    while True:
        # Sleep with backoff
        if consecutive_failures >= 3:
            backoff = min(2**consecutive_failures, max_backoff)
            log.warning("Backoff: sleeping %.1fs after %d failures", backoff, consecutive_failures)
            time.sleep(backoff)
        else:
            time.sleep(interval)

        _reap_server_child()

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
                    # System totals alongside the per-process RSS: the server's own
                    # footprint stays flat while the box fills up around it, so the
                    # process number alone cannot show memory pressure building.
                    log.info(
                        "Server PID=%d | CPU=%.1f%% | RSS=%.1fMB | %s",
                        server_pid,
                        cpu,
                        mem_mb,
                        memory_snapshot(top_n=0),
                    )
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            last_resource_log = now

        if check_server_health(port):
            if consecutive_failures > 0:
                log.info("Server recovered after %d failures", consecutive_failures)
            consecutive_failures = 0
            continue

        consecutive_failures += 1
        # Record the machine before deciding anything. A health check fails for want
        # of memory as often as for a real hang, and the two are indistinguishable
        # afterwards without this line. The monitor is a separate process, so it
        # still gets written when the server itself is too starved to log.
        log.warning(
            "Health check failed (attempt %d) | %s",
            consecutive_failures,
            memory_snapshot(),
        )

        server_pid = _live_server_pid()

        if server_pid:
            if consecutive_failures < restart_failure_threshold:
                log.warning(
                    "Server PID=%d alive but health check failed — waiting for %d consecutive failures before restart",
                    server_pid,
                    restart_failure_threshold,
                )
                continue

            log.warning("Server PID=%d alive but unhealthy — killing", server_pid)
            _kill_server(server_pid)
            time.sleep(1)

        # Restart server. The new backend records its own pid in server.json
        # from its startup hook; the monitor writes nothing here.
        new_pid = start_server_process(port)

        if wait_for_server_health(port, timeout=10.0):
            log.info("Server restarted successfully (PID=%d)", new_pid)
            consecutive_failures = 0
        else:
            log.error("Server failed to become healthy after restart (PID=%d)", new_pid)


def launch_monitor(port: int) -> None:
    """Main entry point — runs IN the monitor process."""
    _setup_logging()
    log.info("Monitor starting (PID=%d, port=%d)", os.getpid(), port)

    if not acquire_monitor_singleton():
        return

    try:
        ensure_monitor_singleton(port)
        log.info("Singleton claimed, checking server health...")

        if check_server_health(port):
            log.info("Server already healthy on port %d — adopting it", port)
        else:
            # Kill any stale server process before starting a fresh one; this
            # frees the port on Windows where TIME_WAIT can block a new bind.
            stale_pid = _live_server_pid()
            if stale_pid:
                log.warning("Killing stale server PID=%d before restart", stale_pid)
                _kill_server(stale_pid)
                time.sleep(1)  # allow port to release

            start_server_process(port)

            if not wait_for_server_health(port, timeout=15.0):
                log.error("Server did not become healthy within 15s (check %s)", _logs_base() / "server")

        # Unconditionally: a monitor that finds a healthy server must supervise
        # it, not exit and leave server.json naming a dead monitor.
        log.info("Entering monitor loop...")
        monitor_loop(port)
    except Exception:
        log.exception("Monitor crashed with unhandled exception")
        raise
    finally:
        _release_monitor_lock()


# ---------------------------------------------------------------------------
# CLI helpers (called from flow_cli.py)
# ---------------------------------------------------------------------------


def start_monitor_detached(port: int) -> int:
    """Launch the monitor as a detached process. Returns monitor PID.

    Writes port + launch time before spawning, never ``monitor_pid``: on
    Windows Popen.pid is the trampoline, not the interpreter, and the monitor
    records its real pid itself within milliseconds (``get_status`` falls back
    to the lock sidecar for that window).
    """
    _set_info({"port": port, "launch_iso_time": datetime.now(timezone.utc).isoformat()})
    return start_detached_process([sys.executable, "-m", "flow_sdk.server.launch", str(port)]).pid


def _scan_for_monitors(port: int) -> list[int]:
    """Pids of every ``flow_sdk.server.launch <port>`` process other than ourselves.

    The fallback that depends on neither server.json nor the sidecar: a
    monitor from before the lock existed, started by any launcher, is still
    found here so ``flow stop`` can end it.
    """
    me, wanted = os.getpid(), str(port)
    found: list[int] = []
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmd = proc.info["cmdline"] or []
            if proc.info["pid"] != me and _MONITOR_CMD_MARKER in cmd:
                idx = cmd.index(_MONITOR_CMD_MARKER)
                if idx + 1 < len(cmd) and cmd[idx + 1] == wanted:
                    found.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return found


def _recorded_monitor_pid(info: dict) -> int | None:
    """The live monitor named by server.json or the lock sidecar, if any."""
    for pid in (info.get("monitor_pid"), singleton_lock.read_pid(_monitor_lock_paths()[1])):
        if pid and _monitor_is_alive(pid):
            return pid
    return None


def _monitor_pids(info: dict, port: int) -> list[int]:
    """Every live monitor for *port*, recorded or not. Exhaustive, so it scans."""
    recorded = _recorded_monitor_pid(info)
    candidates = dict.fromkeys(pid for pid in (recorded, *_scan_for_monitors(port)) if pid)
    return [pid for pid in candidates if pid == recorded or _monitor_is_alive(pid)]


def stop_all() -> tuple[bool, bool]:
    """Kill monitor + server from flow_sdk.server.json. Returns (monitor_killed, server_killed)."""
    from flow_sdk.core.connections.service import service_lifecycle_mutation

    with service_lifecycle_mutation():
        return _stop_all_guarded()


def _stop_all_guarded() -> tuple[bool, bool]:
    """Stop while the caller holds the lifecycle mutation guard."""
    info = _load_info()
    port = info.get("port", DEFAULT_PROD_PORT)
    monitor_killed = False
    server_killed = False

    # Every monitor first, so none of them restarts the server we kill next.
    for monitor_pid in _monitor_pids(info, port):
        monitor_killed = kill_process(monitor_pid) or monitor_killed

    server_pid = info.get("server_pid")
    if server_pid and is_process_alive(server_pid, expected_name=_SERVER_CMD_MARKER):
        server_killed = kill_process(server_pid)

    # Clear PIDs from server.json
    from flow_sdk.config import clear_server_info

    clear_server_info()

    return monitor_killed, server_killed


def get_status() -> dict:
    """Return dict with monitor/server alive booleans, health, PIDs.

    ``server_pid`` is whatever the backend last wrote. Between the monitor
    spawning a backend and that backend's startup hook (up to ~15s) the key is
    absent or stale, so ``flow status`` reports the server as not running for
    that window rather than naming a pid nobody has verified.
    """
    info = _load_info()
    port = info.get("port", DEFAULT_PROD_PORT)
    # Recorded sources first; the process scan only when neither names a live
    # monitor, so the common case never pays for it.
    live_monitor = _recorded_monitor_pid(info) or next(iter(_monitor_pids(info, port)), None)
    server_pid = info.get("server_pid")

    return {
        "port": port,
        "monitor_pid": live_monitor or info.get("monitor_pid"),
        "monitor_alive": live_monitor is not None,
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
