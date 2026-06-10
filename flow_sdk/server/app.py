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

# Run the declarative type-info registrations (register_all) at import time so
# per-type TypeInfo extras — icon/browseable/creatable authored in
# flow_sdk/schema/type_info/*.py — are present before the first bootstrap.
# Entities self-register via their metaclass on import; this import's side
# effect is what lands the declarative metadata (icons, etc.).
import flow_sdk.fs_store.indexer.registrations  # noqa: E402, F401

from flow_sdk.server import FlowServer

from .routes import (
    assets_router,
    auth_router,
    cloud_router,
    chat_router,
    debug_router,
    detection_router,
    navigate_router,
    agent_records_router,
    transcripts_router,
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
    dep_graph_router,
    version_router,
    favorites_router,
    markdown_index_router,
    docs_graph_router,
    semantic_checker_router,
    pty_stream_router,
)


async def _on_server_startup():
    """Write server.json for discovery by hooks/CLI and start cron scheduler."""
    from flow_sdk.config import set_server_info
    from flow_sdk.db.drivers.sqlite.connection import get_database_path
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    print(f"  Database path: {get_database_path()}")

    # Development: mirror all logs to a file on disk in addition to the
    # console, so a session can be inspected after the fact. No-op in prod.
    try:
        from flow_sdk.service_log import init_dev_file_logging

        _dev_log = init_dev_file_logging()
        if _dev_log:
            print(f"  Dev file log: {_dev_log}")
    except Exception as _e:  # noqa: BLE001
        print(f"  Dev file log: failed to init ({_e})")

    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        return

    set_server_info(
        {
            "port": settings.port,
            "server_pid": os.getpid(),
            "webhook_path": "/api/v1/webhook/listen",
            "health_path": "/api/v1/health/status",
        }
    )
    print(f"  server.json:   {settings.server_json_path}")

    from flow_sdk.fs_store.operations.record_retention import run_old_record_cleanup

    threading.Thread(target=run_old_record_cleanup, daemon=True, name="old-record-cleanup").start()

    # Seed system Capability rows (claude/codex/chrome + the Default-harness
    # reference). The generic graph routes hit the DB directly — they never
    # pass through Capability.get_all's lazy ensure_seeded — so a fresh
    # instance must seed deterministically at boot.
    try:
        from flow_sdk.builtin.capability import Capability

        await Capability.ensure_seeded()
    except Exception as _e:  # noqa: BLE001
        print(f"  Capability seed: failed ({_e})")

    # Discover capability values in the background (every restart). The env
    # probe runs in a separate subprocess with a hard cap — nothing blocks
    # startup; values land in the discovery dict + entity rows when ready.
    try:
        import asyncio as _asyncio_disc

        from flow_sdk.core.capabilities.discovery import run_discovery

        _asyncio_disc.create_task(run_discovery(), name="capability-discovery")
        print("  Capability discovery: started (background)")
    except Exception as _e:  # noqa: BLE001
        print(f"  Capability discovery: failed to start ({_e})")

    # PTY recovery watchdog: respawn visible sessions whose worker died — both at
    # startup (restart kills PTY children) AND periodically while running (a
    # worker that crashes mid-session). Background — startup never blocks;
    # recovered sessions push a ``recovered`` event on (re)watch. This is the
    # backend home for what used to be the frontend os-status recovery poll.
    try:
        import asyncio as _asyncio_pty

        from flow_sdk.server.pty_recovery import start_recovery_task

        _asyncio_pty.create_task(start_recovery_task(), name="pty-recovery")
        print("  PTY recovery: started (background, periodic)")
    except Exception as _e:  # noqa: BLE001
        print(f"  PTY recovery: failed to start ({_e})")

    # Search uses FTS5 (built into SQLite) — no external index needed.
    print("  Search index: FTS5 (SQLite built-in)")

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
    await _start_inbox_catchup()
    await _seed_service_triggers()
    await _start_fsop_watcher()
    await _start_transcript_streamer()


async def _seed_service_triggers() -> None:
    """Upsert built-in system triggers (toplog filter watcher, etc.). Must run
    before `_start_fsop_watcher()` so the watcher's startup walk finds them."""
    try:
        from flow_sdk.server.builtin_triggers import set_service_triggers

        await set_service_triggers()
        print("  System triggers: upserted")
    except Exception:
        logging.getLogger(__name__).exception("System triggers: failed to seed")


async def _start_fsop_watcher() -> None:
    """Start the FSOp watcher: catch up, then spawn one awatch task per trigger."""
    try:
        from flow_sdk.server.fsop_watcher import fsop_watcher

        await fsop_watcher.start()
        print(f"  FSOp watcher: started ({len(fsop_watcher)} trigger(s))")
    except Exception:
        logging.getLogger(__name__).exception("FSOp watcher: failed to start")


async def _start_transcript_streamer() -> None:
    """T6: Start the TranscriptStreamer's idle sweeper, then kick off a one-shot
    catch-up walk over existing JSONLs in the background.

    Catch-up closes the "modified while server was down" gap: FSOp can't fire
    for files that haven't changed since startup, and folder-mode FSOp catch-up
    is intentionally skipped. The walk lazily constructs a streamer per file
    (full initial parse via ``AgentTranscriptFile.__init__``), then
    ``parse_delta()`` flushes everything as one chunk to subscribers.

    The walk runs as a background task (not awaited in the lifespan) so the
    server reaches the listen phase immediately — users may have thousands
    of historical JSONLs (~7-8K is realistic), and parsing them all serially
    would block boot for minutes. Subscribers are idempotent, so a live FSOp
    event for the same file racing the catch-up walk is safe.
    """
    try:
        import asyncio as _asyncio

        from flow_sdk.transcript_streamer import transcript_streamer_registry

        await transcript_streamer_registry.start_idle_sweeper()
        _asyncio.create_task(_transcript_catch_up_walk(), name="transcript-catch-up")
        print("  Transcript streamer: started (catch-up scheduled in background)")
    except Exception:
        logging.getLogger(__name__).exception("Transcript streamer: failed to start")


async def _transcript_catch_up_walk() -> None:
    """Background catch-up walk over every JSONL under the watched dirs."""
    try:
        from flow_sdk.instance_settings import get_instance_settings
        from flow_sdk.transcript_streamer import transcript_streamer_registry

        settings = get_instance_settings()
        roots = [settings.claude_projects_dir, settings.codex_sessions_dir]
        scanned = 0
        for root in roots:
            if not root.exists():
                continue
            for jsonl in root.rglob("*.jsonl"):
                try:
                    await transcript_streamer_registry.notify_change(jsonl)
                    scanned += 1
                except Exception:
                    logging.getLogger(__name__).exception(
                        "Transcript streamer catch-up failed for %s", jsonl
                    )
        logging.getLogger(__name__).info(
            "Transcript streamer catch-up: scanned %d JSONL(s)", scanned
        )
    except Exception:
        logging.getLogger(__name__).exception("Transcript streamer catch-up failed")


async def _start_notification_scanner() -> None:
    """Scan for incoming notifications on startup."""
    try:
        from flow_sdk.app.actions.notification_scanner import scan_incoming_notifications
        from flow_sdk.builtin.user import User as _User
        import asyncio as _asyncio
        local_user = await _User.get_one({"uname": "local"})
        if local_user:
            _asyncio.create_task(scan_incoming_notifications(local_user.id))
    except Exception as e:
        print(f"  Notification scanner: failed to start ({e})")


async def _start_inbox_catchup() -> None:
    """Pull any FlowMessages that landed on the hub while the app was offline.

    The hub WebSocket only pushes live events; it does not replay history on
    (re)connect, so a user who closes the app overnight and reopens it would
    otherwise see an empty inbox until something else (manual refresh, an
    inbound live message, ...) triggers a fetch. This sweep closes that gap.
    """
    import asyncio as _asyncio

    async def _run() -> None:
        try:
            from flow_sdk.app.actions.flow_message_action import handle_conversation_list
            from flow_sdk.builtin.user import User as _User
            from flow_sdk.cli.auth.hub_login import hub_auth_available

            # No cloud session → the hub would 401 every conversation/invitation
            # call. Skip the catch-up entirely instead of logging 401 warnings
            # on every offline startup.
            if not hub_auth_available():
                return
            local_user = await _User.get_one({"uname": "local"})
            if not local_user:
                return
            resp = await handle_conversation_list(local_user.typeid)
            data = getattr(resp, "data", None) or {}
            dispatched = data.get("bg_fetch_dispatched") or []
            if dispatched:
                logging.getLogger(__name__).info(
                    "Inbox catch-up: queued bundle fetch for %d conversation(s)", len(dispatched),
                )
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).info("Inbox catch-up skipped: %s", exc)

    _asyncio.create_task(_run())


async def _start_cloud_ws_listener() -> None:
    """Start the outbound authenticated hub WebSocket listener when logged in."""
    import asyncio as _asyncio

    async def _run() -> None:
        try:
            from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
            from flow_sdk.cloud_client.ws_client import hub_ws_manager

            # Install the bridge before starting the manager so the inbound
            # dispatcher is ready to consume frames the moment the WS connects.
            hub_ws_bridge.install()
            await hub_ws_manager.start()
        except Exception as e:
            logging.getLogger(__name__).info("Cloud WS listener: failed to start (%s)", e)

    _asyncio.create_task(_run(), name="cloud-ws-listener-startup")


async def _shutdown_extras():
    """Clean up server.json and stop cron scheduler."""
    from flow_sdk.config import clear_server_info

    # Stop cron scheduler
    try:
        from flow_sdk.server.scheduler import stop_scheduler

        stop_scheduler()
    except Exception:
        pass

    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        await hub_ws_manager.stop()
    except Exception:
        pass

    # Stop FSOp watcher — cancel all per-trigger awatch tasks
    try:
        from flow_sdk.server.fsop_watcher import fsop_watcher

        await fsop_watcher.stop()
    except Exception:
        pass

    # Stop the TranscriptStreamer idle sweeper. Streamer dict drops with the
    # process — no other cleanup needed.
    try:
        from flow_sdk.transcript_streamer import transcript_streamer_registry

        await transcript_streamer_registry.stop_idle_sweeper()
    except Exception:
        pass

    print("Shutting down minihub server...")
    clear_server_info()
    print("Shutdown complete.")


server = FlowServer()
server.add_router(auth_router)
server.add_router(cloud_router)
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
server.add_router(agent_records_router)
server.add_router(transcripts_router)
server.add_router(dep_graph_router)
server.add_router(version_router)
server.add_router(favorites_router)
server.add_router(markdown_index_router, prefix="/api/v1")
server.add_router(pty_stream_router, prefix="/api/v1")
server.add_router(docs_graph_router)
server.add_router(semantic_checker_router)

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


# ── Root-level public files ──────────────────────────────────────────────────
# Files in ``ui/public/`` end up at the root of the built ``dist/`` (and thus
# at the root of ``flow_sdk/server/static/``). These are referenced from places
# the JS bundle can't fingerprint — ``index.html`` itself (favicon, og:image)
# and the ``ws-test.html`` dev page. JSX-imported icons live in
# ``ui/src/assets/`` instead and are served via the hashed ``/assets/`` mount.
#
# Explicit list (no broad ``mount("/", ...)``) keeps the public surface
# auditable: adding a new file requires editing this set.
_PUBLIC_ROOT_FILES: tuple[str, ...] = ("favicon.ico", "logo.png", "ws-test.html")


def _serve_public_file(name: str):
    """Build a GET handler that returns ``static_root / name`` or 404."""
    static_root = _assets_path.parent if _assets_path else None

    async def _handler():
        from fastapi.responses import FileResponse, HTMLResponse

        if static_root is None:
            return HTMLResponse(content="not found", status_code=404)
        candidate = static_root / name
        if not candidate.exists():
            return HTMLResponse(content="not found", status_code=404)
        return FileResponse(candidate)

    return _handler


if _assets_path and _assets_path.exists():
    for _public_name in _PUBLIC_ROOT_FILES:
        app.add_api_route(
            f"/{_public_name}",
            _serve_public_file(_public_name),
            methods=["GET"],
            include_in_schema=False,
        )


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


def wait_for_login_callback(timeout_sec: int = None):
    """
    Wait for the login_callback endpoint to be called.
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
        timeout_str = get_config_value("login_callback_timeout")
        timeout_sec = int(timeout_str) if timeout_str else 30

    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    port = get_instance_settings().port

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
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    port = get_instance_settings().port
    print(f"Starting minihub server on http://127.0.0.1:{port}")
    start_server(port)
