#!/usr/bin/env python3
"""
Local FastAPI server for Flow CLI.

This module initializes the FastAPI app using the FlowServer builder
and includes all app-specific route modules.
"""

import os
import sys
import threading
import time
from pathlib import Path

# Track startup timing
_startup_times = {"module_import_start": time.time()}

import logging

import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s:%(name)s:%(message)s")
from fastapi.staticfiles import StaticFiles

from flow_sdk.cli.config_manager import get_config_value, setup_defaults

from . import state

# ── Load entities & actions BEFORE importing routes (resolves circular deps) ──
_startup_times["before_build"] = time.time()

from flow_sdk.core.loaders import load_actions, load_entities

load_entities()
load_actions()

from flow_sdk.server import FlowServer

from .routes import (
    assets_router,
    auth_api_router,
    auth_router,
    chat_router,
    debug_router,
    detection_router,
    navigate_router,
    directory_router,
    hooks_router,
    search_router,
    project_router,
    testing_router,
    ui_router,
    watch_router,
    webhook_api_router,
    websocket_router,
    compute_register_router,
)


async def _on_server_startup():
    """Write server.json for discovery by hooks/CLI and start cron scheduler."""
    from flow_sdk.config import DEV_SERVER_JSON_PATH, SERVER_JSON_PATH, _is_dev_mode, set_server_info
    from flow_sdk.db.drivers.sqlite.connection import SQLITE_DATABASE_PATH

    print(f"  Database path: {SQLITE_DATABASE_PATH}")

    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        return

    port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))
    set_server_info(
        {
            "port": port,
            "server_pid": os.getpid(),
            "webhook_path": "/api/v1/webhook/listen",
            "health_path": "/api/v1/health/status",
        }
    )
    json_path = DEV_SERVER_JSON_PATH if _is_dev_mode() else SERVER_JSON_PATH
    print(f"  server.json:   {json_path}")

    from flow_sdk.fs_records.old_record_cleanup import run_old_record_cleanup

    threading.Thread(target=run_old_record_cleanup, daemon=True, name="old-record-cleanup").start()

    # Search uses FTS5 (built into SQLite) — no external indexer needed.
    print("  Search indexer: FTS5 (SQLite built-in)")

    # Start cron job scheduler
    try:
        from flow_sdk.server.scheduler import start_scheduler

        start_scheduler()
        print("  Cron scheduler: started")
    except Exception as e:
        print(f"  Cron scheduler: failed to start ({e})")

    # Warm schema cache in background so first bootstrap call is fast
    import asyncio as _asyncio

    from flow_sdk.core.schema import get_public_schema as _warm_schema

    _asyncio.create_task(_asyncio.to_thread(_warm_schema))

    await _start_notification_scanner()
    await _start_cloud_ws_listener()


async def _start_notification_scanner() -> None:
    """Scan for incoming notifications on startup."""
    try:
        from flow_sdk.fs_records.notification_scanner import scan_incoming_notifications
        from flow_sdk.builtin.user import User as _User
        import asyncio as _asyncio
        local_user = await _User.get_one({"uname": "local"})
        if local_user:
            _asyncio.create_task(scan_incoming_notifications(local_user.id))
    except Exception as e:
        print(f"  Notification scanner: failed to start ({e})")


async def _start_cloud_ws_listener() -> None:
    """Stub: real-time cloud push notifications not yet implemented.

    TODO: Connect to flowpad.ai cloud WebSocket to receive notification
    push events in real time. For now, notifications reach the recipient via
    the email deep-link → git pull → manifest scanner path.
    """
    import logging as _logging
    _logging.getLogger(__name__).info(
        "Cloud WS listener: not started (real-time push from cloud is a stub — "
        "notifications arrive via email deep-link + git pull instead)"
    )


async def _shutdown_extras():
    """Clean up server.json and stop cron scheduler."""
    from flow_sdk.config import clear_server_info

    # Stop cron scheduler
    try:
        from flow_sdk.server.scheduler import stop_scheduler

        stop_scheduler()
    except Exception:
        pass

    print("Shutting down minihub server...")
    clear_server_info()
    print("Shutdown complete.")


server = FlowServer()
server.add_router(auth_router)
server.add_router(auth_api_router)
server.add_router(hooks_router)
server.add_router(chat_router)
server.add_router(directory_router)
server.add_router(detection_router)
server.add_router(search_router)
server.add_router(testing_router)
server.add_router(ui_router)
server.add_router(watch_router)
server.add_router(websocket_router)
server.add_router(webhook_api_router)
server.add_router(assets_router)
server.add_router(project_router, prefix="/api/v1")
server.add_router(compute_register_router)
server.add_router(debug_router)
server.add_router(navigate_router)

server.on_startup(_on_server_startup)
server.on_shutdown(_shutdown_extras)

app = server.create()


# ── Mount UI assets (before graph catch-all already handled by FlowServer) ───
# Priority: ui/dist/assets (Vite build) > static/assets > legacy dist/assets
def _get_assets_path() -> Path | None:
    """Find the assets directory, handling both dev and PyInstaller modes."""
    if getattr(sys, "frozen", False):
        # PyInstaller bundle — assets are in _MEIPASS/server/static/assets
        return Path(sys._MEIPASS) / "server" / "static" / "assets"
    else:
        server_dir = Path(__file__).parent
        repo_root = server_dir.parent
        candidates = [
            repo_root / "ui" / "dist" / "assets",
            server_dir / "static" / "assets",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
    return None


_assets_path = _get_assets_path()
if _assets_path and _assets_path.exists():
    app.mount("/assets", StaticFiles(directory=str(_assets_path)), name="assets")


# ── Mount SDK static files (/sdk/flowpad-sdk.js) ─────────────────────────────
def _get_sdk_path() -> Path | None:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "minihub" / "static" / "sdk"
    else:
        return Path(__file__).parent / "static" / "sdk"


_sdk_path = _get_sdk_path()
if _sdk_path and _sdk_path.exists():
    app.mount("/sdk", StaticFiles(directory=str(_sdk_path)), name="sdk")

# ── SPA fallback ─────────────────────────────────────────────────────────────
from fastapi import Request as _Request
from fastapi.responses import HTMLResponse as _HTMLResponse

from .routes.ui import _get_index_candidates


@app.get("/{full_path:path}")
async def _spa_fallback(request: _Request, full_path: str):
    # Don't intercept API, health, or asset routes
    if full_path.startswith(("api/", "health/", "assets/", "sdk/", "ping", "prompt")):
        return _HTMLResponse(content="Not found", status_code=404)
    for candidate in _get_index_candidates():
        if candidate.exists():
            return _HTMLResponse(content=candidate.read_text())
    return _HTMLResponse(content="UI not found", status_code=404)


_startup_times["after_app_init"] = time.time()


def _print_startup_timing():
    """Print detailed startup timing information."""
    if not _startup_times:
        return

    print("\n" + "=" * 60)
    print("SERVER STARTUP TIMING REPORT")
    print("=" * 60)

    start = _startup_times.get("module_import_start", 0)

    # Phase timings
    phases = [
        ("build_and_init", "before_build", "after_app_init"),
    ]

    total_measured = 0
    for phase_name, before_key, after_key in phases:
        if before_key in _startup_times and after_key in _startup_times:
            elapsed = _startup_times[after_key] - _startup_times[before_key]
            total_measured += elapsed
            print(f"  {phase_name:<20} {elapsed * 1000:7.2f} ms")

    module_to_app = _startup_times["after_app_init"] - start
    print("-" * 60)
    print(f"  {'Total (import->ready)':<20} {module_to_app * 1000:7.2f} ms")
    print("=" * 60 + "\n")


def start_server(port: int):
    """
    Start the FastAPI server in the current thread.

    Args:
        port: Port number to listen on
    """
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


def wait_for_post_login(timeout_sec: int = None):
    """
    Wait for the post_login endpoint to be called.
    Runs the server in a separate thread and waits for login.

    Args:
        timeout_sec: Timeout in seconds (if None, uses config default)

    Returns:
        dict: Login result if received, or timeout error
    """
    # Reset state
    state.login_result = None
    state.login_received.clear()

    # Get config values
    setup_defaults()

    # Get timeout from config if not provided
    if timeout_sec is None:
        timeout_str = get_config_value("post_login_timeout")
        timeout_sec = int(timeout_str) if timeout_str else 30

    port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))

    # Start server in daemon thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Give server time to start
    time.sleep(1)

    print(f"Local server started on http://127.0.0.1:{port}")
    print(f"Waiting for login (timeout: {timeout_sec}s)...")

    # Wait for login with timeout
    if state.login_received.wait(timeout=timeout_sec):
        return state.login_result
    else:
        return {"success": False, "error": "Timeout", "message": f"No login received within {timeout_sec} seconds"}


if __name__ == "__main__":
    setup_defaults()
    port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))
    print(f"Starting minihub server on http://127.0.0.1:{port}")
    start_server(port)
