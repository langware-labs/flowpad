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

# Warm the per-type payload list now that every TypeInfo is registered. The
# ~225ms assembly is static after registration, so building it here — at import,
# before the server listens — keeps it off the first (cold) bootstrap request.
# Default args (include_schema=True) match bootstrap's call, so it's a cache hit.
try:
    from flow_sdk.core.schema import build_all_type_payloads as _warm_type_payloads

    _warm_type_payloads()
except Exception:
    logging.getLogger(__name__).exception("Failed to warm type payloads at startup")

from flow_sdk.server import FlowServer

from .routes import (
    agent_records_router,
    agentic_flows_router,
    assets_router,
    auth_router,
    capabilities_router,
    chat_router,
    cloud_router,
    compute_register_router,
    debug_router,
    dep_graph_router,
    detection_router,
    directory_router,
    docs_graph_router,
    favorites_router,
    git_router,
    hooks_router,
    journeys_router,
    markdown_index_router,
    navigate_router,
    privacy_router,
    project_router,
    pty_stream_router,
    search_router,
    semantic_checker_router,
    subgraph_router,
    tags_router,
    testing_router,
    toplog_router,
    transcripts_router,
    ui_router,
    version_router,
    watch_router,
    webhook_api_router,
    websocket_router,
    worldview_router,
)


async def _on_server_startup():
    """Write server.json for discovery by hooks/CLI and start cron scheduler."""
    from flow_sdk.builtin.process_lifecycle import clear_backend_restart_request
    from flow_sdk.config import set_server_info
    from flow_sdk.db.drivers.sqlite.connection import get_database_path
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    clear_backend_restart_request()
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

    set_server_info(
        {
            "port": settings.port,
            "server_pid": os.getpid(),
            "webhook_path": "/api/v1/webhook/listen",
            "health_path": "/api/v1/health/status",
        }
    )
    print(f"  server.json:   {settings.server_json_path}")
    if os.environ.get("FLOWPAD_SKIP_LOCK", "").lower() == "true":
        print("  singleton lock: skipped (FLOWPAD_SKIP_LOCK=true)")

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

    # Seed the shipped tag vocabulary as system Tag entities (the taxonomy
    # catalog IS the entities — no separate registry). Idempotent: uuid5 ids
    # converge on re-runs; user tags are never touched.
    try:
        from flow_sdk.builtin.tag import seed_system_tags

        _tag_rows = await seed_system_tags()
        print(f"  Tag seed: {_tag_rows} row(s) written")
    except Exception as _e:  # noqa: BLE001
        print(f"  Tag seed: failed ({_e})")

    # Discover capability values in the background (every restart). The env
    # probe runs in a separate subprocess with a hard cap — nothing blocks
    # startup; values land in the discovery dict + entity rows when ready.
    try:
        import asyncio as _asyncio_disc

        from flow_sdk.core.capabilities.discovery import run_discovery
        from flow_sdk.core.capabilities.mcp import reconcile_mcp_capabilities

        _asyncio_disc.create_task(run_discovery(), name="capability-discovery")
        # Mint MCP-server capabilities (<service>.mcp.<worker_type>) from the
        # indexed records so they exist after boot.
        _asyncio_disc.create_task(reconcile_mcp_capabilities(), name="mcp-capability-reconcile")
        print("  Capability discovery: started (background)")
    except Exception as _e:  # noqa: BLE001
        print(f"  Capability discovery: failed to start ({_e})")

    # Reconcile orphaned headless workers BEFORE serving: a restart kills the
    # previous backend's child workers, but their ``visible=false`` records keep
    # status=RUNNING and would show as phantom "Background" agents in the footer
    # chip. Stamp them STOPPED now (pure DB writes — no spawn — so the first
    # bootstrap is already clean). Visible PTYs are handled by the recovery
    # watchdog below, not here.
    try:
        from flow_sdk.server.pty_recovery import reconcile_orphaned_workers

        await reconcile_orphaned_workers()
        print("  Orphaned-worker reconcile: done")
    except Exception as _e:  # noqa: BLE001
        print(f"  Orphaned-worker reconcile: failed ({_e})")

    # PTY recovery watchdog: respawn a visible session whose worker died, but only
    # while a live UI is watching it (on-demand — never a global sweep, which would
    # exhaust the pty device pool). Periodic, so a worker that crashes mid-session
    # in an open UI is respawned; at boot nothing is watched, so restart recovery
    # lands on the first tick after a client re-watches. Background — startup never
    # blocks; recovered sessions push a ``recovered`` event on (re)watch.
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

    # Arm backend→app tag forwarding (unified event bus — docs/flow-events.md).
    try:
        from flow_sdk.tags.ws_forward import start_tag_forwarding

        start_tag_forwarding()
        print("  Tag forwarding: armed")
    except Exception as _e:  # noqa: BLE001
        print(f"  Tag forwarding: failed to arm ({_e})")

    # Warm schema cache in background so first bootstrap call is fast
    import asyncio as _asyncio

    from flow_sdk.core.schema import get_public_schema as _warm_schema

    _asyncio.create_task(_asyncio.to_thread(_warm_schema))

    await _start_notification_scanner()
    await _start_cloud_ws_listener()
    await _start_inbox_catchup()
    await _seed_service_triggers()
    await _prune_orphan_scheduler_jobs()
    await _start_fsop_watcher()
    await _start_transcript_streamer()
    await _start_system_content_index()


async def _start_system_content_index() -> None:
    """Spawn the once-per-process system content index (system projects,
    markdown docs, assistant assets) as a detached background task. This
    used to run inline in the bootstrap request path — see
    ``bootstrap.index_system_content`` for why it must not."""
    try:
        import asyncio as _asyncio

        from flow_sdk.server.routes.bootstrap import index_system_content

        _asyncio.create_task(index_system_content(), name="system-content-index")
        print("  System content index: scheduled (background)")
    except Exception:
        logging.getLogger(__name__).exception("System content index: failed to start")


async def _prune_orphan_scheduler_jobs() -> None:
    """Drop persisted APScheduler jobs that no longer map to a live trigger.

    Runs after `_seed_service_triggers()` so the current builtin/user triggers
    are registered first; everything left in the jobstore without a matching
    entity is a stale orphan (see ``prune_orphan_scheduler_jobs``)."""
    try:
        from flow_sdk.server.scheduler import prune_orphan_scheduler_jobs

        pruned = await prune_orphan_scheduler_jobs()
        print(f"  Scheduler jobstore: pruned {pruned} orphan job(s)")
    except Exception:
        logging.getLogger(__name__).exception("Scheduler jobstore: orphan prune failed")


async def _seed_service_triggers() -> None:
    """Upsert built-in system triggers (toplog filter watcher, etc.). Must run
    before `_start_fsop_watcher()` so the watcher's startup walk finds them."""
    try:
        from flow_sdk.server.builtin_triggers import set_service_triggers

        await set_service_triggers()
        # Seed the system-scope service flows (mini-analyzer, daily-analysis).
        try:
            from flow_sdk.flow_manager.service_flows import set_service_flows

            await set_service_flows()
        except Exception:
            logging.getLogger(__name__).exception("set_service_flows failed")
        print("  System triggers: upserted")
    except Exception:
        logging.getLogger(__name__).exception("System triggers: failed to seed")


async def _start_fsop_watcher() -> None:
    """Start the FSOp watcher: catch up, then spawn one awatch task per trigger."""
    try:
        from flow_sdk.server.fsop_watcher import fsop_watcher

        await fsop_watcher.start()
        # Arm TAG triggers (unified-bus subscriptions — flow-events phase 4).
        from flow_sdk.builtin.tag_triggers import start_tag_triggers

        await start_tag_triggers()
        # Arm graph-level flow subscriptions (flow-events phase 5).
        from flow_sdk.flow_manager import get_flow_manager

        await get_flow_manager().arm_all_flow_subscriptions()
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

        from flow_sdk.instance_settings import get_instance_settings
        from flow_sdk.transcript_streamer import transcript_streamer_registry

        # Persisted cursors: lets the catch-up walk skip every file already
        # consumed in a prior run instead of re-parsing the full history.
        await _asyncio.to_thread(
            transcript_streamer_registry.configure_cursors,
            get_instance_settings().transcript_cursors_path,
        )
        await transcript_streamer_registry.start_idle_sweeper()
        _asyncio.create_task(_transcript_catch_up_walk(), name="transcript-catch-up")
        print("  Transcript streamer: started (catch-up scheduled in background)")
    except Exception:
        logging.getLogger(__name__).exception("Transcript streamer: failed to start")


async def _transcript_catch_up_walk() -> None:
    """Background catch-up walk over the JSONLs under the watched dirs.

    Discovery (rglob + stat) runs in a worker thread, and the persisted
    cursor store filters out every file whose size/mtime is unchanged since
    it was last consumed — so a routine restart parses only what actually
    changed while the server was down, not the full history.
    """
    try:
        import asyncio as _asyncio

        from flow_sdk.instance_settings import get_instance_settings
        from flow_sdk.server.routes.bootstrap import first_bootstrap_served
        from flow_sdk.transcript_streamer import transcript_streamer_registry

        # Defer the historical re-parse until the first bootstrap has been served.
        # On a fresh instance this walk re-parses the entire ~/.claude history;
        # its parse threads hold the GIL back-to-back and would otherwise ~3×
        # the wall time of the concurrent cold-start bootstrap. The walk is
        # low-priority (it only closes the "modified while offline" gap and
        # subscribers are idempotent), so letting the critical request finish
        # first costs nothing functional.
        await first_bootstrap_served.wait()

        settings = get_instance_settings()
        roots = [settings.claude_projects_dir, settings.codex_sessions_dir]

        def _discover() -> tuple[list, int]:
            pending = []
            total = 0
            for root in roots:
                if not root.exists():
                    continue
                for jsonl in root.rglob("*.jsonl"):
                    total += 1
                    if transcript_streamer_registry.needs_catch_up(jsonl):
                        pending.append(jsonl)
            return pending, total

        pending, total = await _asyncio.to_thread(_discover)
        scanned = 0
        for jsonl in pending:
            try:
                await transcript_streamer_registry.notify_change(jsonl)
                scanned += 1
            except Exception:
                logging.getLogger(__name__).exception("Transcript streamer catch-up failed for %s", jsonl)
        await transcript_streamer_registry.flush_cursors()
        logging.getLogger(__name__).info(
            "Transcript streamer catch-up: parsed %d of %d JSONL(s) (%d fresh, skipped)",
            scanned,
            total,
            total - len(pending),
        )
    except Exception:
        logging.getLogger(__name__).exception("Transcript streamer catch-up failed")


async def _start_notification_scanner() -> None:
    """Scan for incoming notifications on startup."""
    try:
        import asyncio as _asyncio

        from flow_sdk.app.actions.notification_scanner import scan_incoming_notifications
        from flow_sdk.builtin.user import User as _User

        local_user = await _User.get_one({"uname": "local"})
        if local_user:
            _asyncio.create_task(scan_incoming_notifications(local_user.id))
    except Exception as e:
        print(f"  Notification scanner: failed to start ({e})")


async def _start_inbox_catchup() -> None:
    """Pull any FlowMessages that landed on the hub while the app was offline.

    Startup is only ONE of the two catch-up transitions — logging in is the
    other, and it runs the same sweep from ``cloud_login._finalize_login``
    (this one bails on ``hub_auth_available()`` when the app boots logged out).
    See ``flow_sdk.inbox.catchup`` for why the sweep exists at all.
    """
    from flow_sdk.inbox.catchup import start_hub_catchup

    start_hub_catchup("startup")


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

    # Close the process-shared outbound hub HTTP client (kept alive across calls
    # so its TLS context isn't rebuilt per request — see hub_http._hub_client).
    try:
        from flow_sdk.cloud_client.transport.hub_http import close_hub_client

        await close_hub_client()
    except Exception:
        pass

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
server.add_router(privacy_router)
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
server.add_router(tags_router)
server.add_router(subgraph_router)
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
server.add_router(capabilities_router)
server.add_router(toplog_router)
server.add_router(agentic_flows_router)
server.add_router(journeys_router)
server.add_router(git_router)
server.add_router(worldview_router)

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

from .routes.ui import _get_index_candidates, serve_index_html


@app.get("/{full_path:path}")
async def _spa_fallback(request: _Request, full_path: str):
    # Don't intercept API, health, or asset routes
    if full_path.startswith(("api/", "health/", "assets/", "sdk/", "ping", "prompt")):
        return _HTMLResponse(content="Not found", status_code=404)
    for candidate in _get_index_candidates():
        if candidate.exists():
            # Inject the runtime API origin so deep links (e.g. /dock/shell/…)
            # hit the serving backend, not the bundle's baked URL.
            return serve_index_html(candidate.read_text())
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
