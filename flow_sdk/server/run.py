#!/usr/bin/env python3
"""
Run script for the flow server.

Usage:
    python -m flow_sdk.server.run
"""

import logging
import os
import sys
import time
from pathlib import Path

# Ensure the repo root and SDK path are on sys.path so "server" and "flow_sdk"
# are importable even when this script is run directly (e.g. `python run.py`).
_repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)
_sdk_path = os.path.join(_repo_root, "sdk", "python")
if _sdk_path not in sys.path:
    sys.path.insert(0, _sdk_path)

import uvicorn
from dotenv import load_dotenv
from filelock import FileLock, Timeout

_lock: FileLock | None = None  # kept alive for the process lifetime


def _pid_alive(pid: int) -> bool:
    """Return True if the process with the given PID is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _acquire_singleton_lock() -> bool:
    """Acquire an exclusive process-level lock to prevent duplicate server instances.

    Uses filelock (fcntl on POSIX, msvcrt on Windows) — kernel-owned, so the
    lock is automatically released if the process crashes without cleanup.
    We also write our PID into the lock file so stale locks can be detected.

    Returns True if the lock was acquired, False if another instance is running.
    Set FLOWPAD_SKIP_LOCK=true to bypass (for isolated test servers).
    """
    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        logging.info("[singleton] Lock skipped (FLOWPAD_SKIP_LOCK=true)")
        return True

    global _lock
    from flow_sdk.config import get_port_file_path
    lock_path = get_port_file_path().with_suffix(".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    def _try_acquire() -> bool:
        global _lock
        _lock = FileLock(str(lock_path), timeout=0)
        try:
            _lock.acquire()
            lock_path.write_text(str(os.getpid()))
            logging.info("[singleton] Lock acquired: pid=%d path=%s", os.getpid(), lock_path)
            return True
        except Timeout:
            return False

    if _try_acquire():
        return True

    # Acquisition failed — read holder PID from lock file (may not exist if server
    # was started before PID-writing was added, or if file was deleted externally).
    try:
        holder_pid = int(lock_path.read_text().strip())
    except Exception:
        holder_pid = 0

    if not holder_pid or not _pid_alive(holder_pid):
        # Either no PID file or the recorded PID is dead — stale fcntl lock or
        # missing file. Remove and retry; fcntl is the real guard.
        if holder_pid:
            logging.warning("[singleton] Stale lock (pid=%d is dead) — removing and retrying", holder_pid)
        else:
            logging.warning("[singleton] No PID in lock file — retrying acquire")
        lock_path.unlink(missing_ok=True)
        if _try_acquire():
            return True

    logging.warning(
        "[singleton] Server already running (pid=%s) — exiting (our pid=%d)",
        holder_pid or "unknown", os.getpid(),
    )
    return False


def _release_singleton_lock() -> None:
    if _lock and _lock.is_locked:
        _lock.release()
        logging.info("[singleton] Lock released: pid=%d", os.getpid())


import flow_sdk.domain  # noqa: F401

# Load environment variables (guard against PyInstaller bundle where find_dotenv fails)
try:
    load_dotenv()
except (FileNotFoundError, OSError):
    pass

# Configuration
# Use 0.0.0.0 to listen on all interfaces (both IPv4 and IPv6)
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 9007


def _register_project_asset_dirs() -> None:
    """Register project-level .claude/skills and .claude/agents dirs via env vars.

    Uses the server's working directory as the project root. Extra dirs are
    appended to FLOWPAD_SKILL_DIRS / FLOWPAD_AGENT_DIRS (colon-separated).
    """
    from pathlib import Path
    cwd = Path.cwd()
    for env_var, subdir in [("FLOWPAD_SKILL_DIRS", ".claude/skills"), ("FLOWPAD_AGENT_DIRS", ".claude/agents")]:
        candidate = cwd / subdir
        if candidate.is_dir():
            existing = os.environ.get(env_var, "")
            candidate_str = str(candidate)
            if candidate_str not in existing.split(":"):
                os.environ[env_var] = f"{existing}:{candidate_str}" if existing else candidate_str


def main():
    """Start the minihub server."""
    startup_start = time.time()
    _register_project_asset_dirs()

    if not _acquire_singleton_lock():
        print(f"[pid={os.getpid()}] Another server instance is already running. Exiting.")
        sys.exit(0)

    host = os.environ.get("MINIHUB_HOST", DEFAULT_HOST)
    port = int(os.environ.get("MINIHUB_PORT", os.environ.get("LOCAL_SERVER_PORT", DEFAULT_PORT)))
    # Auto-reload disabled by default; set MINIHUB_RELOAD=true to enable for development
    reload_enabled = os.environ.get("MINIHUB_RELOAD", "false").lower() == "true"

    print(f"Starting Flowpad server at http://{host}:{port}")
    print(f"Bootstrap endpoint: http://{host}:{port}/api/v1/graph/bootstrap")
    if reload_enabled:
        print(f"Auto-reload: enabled (watching *.py files)")

    uvicorn_kwargs = {
        "host": host,
        "port": port,
        "log_level": "info",
    }

    if reload_enabled:
        # Resolve watch directories relative to the repo root
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        uvicorn_kwargs["reload"] = True
        uvicorn_kwargs["reload_includes"] = ["*.py"]
        uvicorn_kwargs["reload_excludes"] = ["__pycache__/**/*"]
        uvicorn_kwargs["reload_dirs"] = [
            os.path.join(repo_root, "flow_sdk"),
            os.path.join(repo_root, "server"),
        ]
        uvicorn.run("flow_sdk.server.app:app", **uvicorn_kwargs)
        _release_singleton_lock()
    else:
        # Import directly when not using reload
        import_start = time.time()
        from flow_sdk.server.app import app, _print_startup_timing
        import_time = time.time() - import_start

        # Show startup timing before starting the server
        _print_startup_timing()
        print(f"Uvicorn initialization starting...")

        total_startup = time.time() - startup_start
        print(f"Total startup time (until Uvicorn starts): {total_startup*1000:.2f} ms\n")

        uvicorn.run(app, **uvicorn_kwargs)

    _release_singleton_lock()


if __name__ == "__main__":
    main()
