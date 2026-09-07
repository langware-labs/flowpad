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

# Ensure the repo root and SDK path are on sys.path so "server" and "flow_sdk"
# are importable even when this script is run directly (e.g. `python run.py`).
_repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)
_sdk_path = os.path.join(_repo_root, "sdk", "python")
if _sdk_path not in sys.path:
    sys.path.insert(0, _sdk_path)

# On Windows the console/stdio defaults to a legacy code page (e.g. cp1252),
# so a log line carrying non-ASCII text — a Hebrew project path, an exception
# traceback referencing one — raises UnicodeEncodeError ("charmap") inside the
# logging StreamHandler, which then silently drops the record. Force UTF-8 on
# stdio before anything logs so those tracebacks reach the captured backend log
# instead of vanishing. No-op on platforms that already default to UTF-8.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

import uvicorn
from dotenv import load_dotenv
from filelock import FileLock

_lock: FileLock | None = None  # kept alive for the process lifetime


def _raise_nofile_soft_limit(min_soft: int = 4096) -> None:
    """Raise the process file-descriptor soft limit when the OS permits it."""
    try:
        import resource
    except ImportError:
        return

    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = min(max(soft, min_soft), hard)
        if target > soft:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
            logging.info("[startup] Raised RLIMIT_NOFILE soft limit from %s to %s", soft, target)
    except (OSError, ValueError) as exc:
        logging.warning("[startup] Could not raise RLIMIT_NOFILE: %s", exc)


def _pid_alive(pid: int) -> bool:
    """Return True if the process with the given PID is still running.

    Delegates to ``pid_probe`` (stdlib-only, safe to import this early). Do not
    inline ``os.kill(pid, 0)`` here: on Windows that delivers a console Ctrl-C
    rather than probing, so the stale-lock check would signal the very backend
    it is asking about — or this process.
    """
    from flow_sdk.pid_probe import pid_is_alive

    return pid_is_alive(pid)


def _acquire_singleton_lock() -> bool:
    """Acquire the per-instance backend lock (see ``flow_sdk.singleton_lock``).

    Returns True if the lock was acquired, False if another backend is running.
    Set FLOWPAD_SKIP_LOCK=true to bypass (for isolated test servers).
    """
    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        logging.info("[singleton] Lock skipped (FLOWPAD_SKIP_LOCK=true)")
        return True

    global _lock
    from flow_sdk import singleton_lock
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    _lock = singleton_lock.acquire(
        settings.server_lock_path, settings.server_pid_path, _pid_alive, logging.getLogger(), "Server"
    )
    return _lock is not None


def _release_singleton_lock() -> None:
    if _lock and _lock.is_locked:
        from flow_sdk import singleton_lock
        from flow_sdk.instance_settings import get_instance_settings

        singleton_lock.release(_lock, get_instance_settings().server_pid_path)
        logging.info("[singleton] Lock released: pid=%d", os.getpid())


# Load environment variables (guard against PyInstaller bundle where find_dotenv fails)
#
# ``override=True`` is load-bearing for the dev/prod dual-instance setup: the
# per-instance ``.env.local`` MUST win over whatever is already in the ambient
# environment. Without it, an ambient ``SQLITE_DATABASE_PATH`` (or any other
# override var) silently shadows ``.env.local`` — e.g. a dev backend inherits
# the prod ``SQLITE_DATABASE_PATH`` and the two instances end up sharing one
# database, clobbering each other's conversation projections.
try:
    from dotenv import find_dotenv

    # FLOWPAD_SKIP_DOTENV: opt-out for isolated test subprocesses that pin
    # LOCAL_SERVER_PORT / SQLITE_DATABASE_PATH via Popen env — without this,
    # ``override=True`` would clobber those back to .env.local's values.
    if os.environ.get("FLOWPAD_SKIP_DOTENV", "").lower() != "true":
        env_name = os.getenv("ENV", ".env.local")
        env_file = find_dotenv(env_name)
        load_dotenv(env_file, override=True)
except (FileNotFoundError, OSError):
    pass

# Build the per-instance settings singleton now that .env.local is loaded.
# Anything imported below that touches FLOW_HOME / .flow paths goes through
# get_instance_settings() and sees the right dev/test/prod resolution.
#
# Drop any stale cache first: ``flow_sdk.config`` constructs
# ``default_service_config = ServiceConfig()`` at module-load time, whose
# ``apply_desktop_config`` validator calls ``get_instance_settings()`` before
# we've had a chance to load .env.local. Without resetting, we'd be locked
# into prod (FLOWPAD_DEV unset at the early call) — both prod and dev
# backends would race for the same ``server.lock`` instead of using their
# distinct ``server.lock`` / ``dev_server.lock`` paths.
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings  # noqa: E402

reset_instance_settings()
get_instance_settings()


def main():
    """Start the minihub server."""
    startup_start = time.time()
    _raise_nofile_soft_limit()

    if not _acquire_singleton_lock():
        print(f"[pid={os.getpid()}] Another server instance is already running. Exiting.")
        sys.exit(0)

    settings = get_instance_settings()
    host = settings.host
    port = settings.port
    reload_enabled = settings.reload_enabled

    print(f"Starting Flowpad server at http://{host}:{port}")
    print(f"Bootstrap endpoint: http://{host}:{port}/api/v1/graph/bootstrap")
    if reload_enabled:
        print("Auto-reload: enabled (watching *.py files)")

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
        from flow_sdk.server.app import _print_startup_timing, app

        # Show startup timing before starting the server
        _print_startup_timing()
        print("Uvicorn initialization starting...")

        total_startup = time.time() - startup_start
        print(f"Total startup time (until Uvicorn starts): {total_startup * 1000:.2f} ms\n")

        uvicorn.run(app, **uvicorn_kwargs)

    _release_singleton_lock()


if __name__ == "__main__":
    main()
