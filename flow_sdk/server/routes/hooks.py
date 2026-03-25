"""
Hook management routes for the local server.
"""

import os
import json
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .. import state

router = APIRouter()


@router.get("/api/hooks/list")
async def list_hooks():
    """List available hooks from .claude/settings.json."""
    try:
        # Get current directory and look for .claude/settings.json
        cwd = Path(os.getcwd())
        settings_file = cwd / ".claude" / "settings.json"

        if not settings_file.exists():
            return JSONResponse(content={
                "hooks": [],
                "settings_file": str(settings_file),
                "exists": False
            })

        with open(settings_file, 'r') as f:
            settings = json.load(f)

        hooks = settings.get("hooks", {})

        return JSONResponse(content={
            "hooks": hooks,
            "settings_file": str(settings_file),
            "exists": True
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@router.post("/api/hooks/toggle")
async def toggle_hook(data: dict):
    """Toggle a hook on/off in .claude/settings.json."""
    try:
        hook_name = data.get("hook_name")
        enabled = data.get("enabled")

        if not hook_name:
            return JSONResponse(
                content={"error": "hook_name is required"},
                status_code=400
            )

        if enabled is None:
            return JSONResponse(
                content={"error": "enabled is required"},
                status_code=400
            )

        cwd = Path(os.getcwd())
        settings_file = cwd / ".claude" / "settings.json"

        if not settings_file.exists():
            return JSONResponse(
                content={"error": ".claude/settings.json not found"},
                status_code=404
            )

        with open(settings_file, 'r') as f:
            settings = json.load(f)

        if "hooks" not in settings:
            settings["hooks"] = {}

        # Toggle the hook
        if hook_name in settings["hooks"]:
            if enabled:
                # If currently disabled (null), we can't re-enable without knowing the original command
                if settings["hooks"][hook_name] is None:
                    return JSONResponse(
                        content={"error": f"Cannot re-enable hook {hook_name} - original command lost. Please reconfigure manually."},
                        status_code=400
                    )
            else:
                # Disable by setting to null
                settings["hooks"][hook_name] = None
        else:
            return JSONResponse(
                content={"error": f"Hook {hook_name} not found"},
                status_code=404
            )

        # Write back
        with open(settings_file, 'w') as f:
            json.dump(settings, f, indent=2)

        return JSONResponse(content={
            "success": True,
            "hook": hook_name,
            "enabled": enabled
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@router.get("/api/hooks/output")
async def get_hook_output():
    """Get recent hook outputs."""
    outputs = await state.buffer_reporter.get_recent()
    return JSONResponse(content={"outputs": outputs})


@router.post("/api/hooks/report")
async def report_hook(data: dict):
    """
    Receive hook event data from flow hooks report command.

    This endpoint receives hook events and broadcasts to all registered reporters.

    Args:
        data: Hook event data (JSON from stdin)

    Returns:
        JSON response with success status
    """
    try:
        # Add timestamp if not present
        if "timestamp" not in data:
            data["timestamp"] = time.time()

        # Report to all registered reporters
        await state.reporter_registry.report_all(data)

        return JSONResponse(content={
            "success": True,
            "message": "Hook event recorded"
        })
    except Exception as e:
        return JSONResponse(
            content={"error": str(e)},
            status_code=500
        )


@router.websocket("/ws/hooks")
async def websocket_hooks(websocket: WebSocket):
    """WebSocket endpoint for streaming hook outputs in real-time."""
    await websocket.accept()
    state.ws_reporter.add_connection(websocket)

    try:
        # Send initial hook buffer from buffer reporter
        initial_outputs = state.buffer_reporter.get_recent_sync()
        await state.ws_reporter.send_initial(websocket, initial_outputs)

        # Keep connection alive and receive messages
        while True:
            try:
                data = await websocket.receive_text()
                # Echo back for heartbeat
                await websocket.send_json({"type": "pong"})
            except WebSocketDisconnect:
                break
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        state.ws_reporter.remove_connection(websocket)
