"""
Chat/Claude session routes for the local server.
"""

import os
import time
import shutil
import threading
import subprocess

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import state

router = APIRouter()


@router.post("/api/chat/send")
async def send_chat_message(data: dict):
    """Send a chat message and spawn background Claude Code session."""
    try:
        message = data.get("message")
        directory = data.get("directory")

        if not message:
            return JSONResponse(
                content={"error": "Message is required"},
                status_code=400
            )

        with state.session_lock:
            session_id = f"session_{state.session_counter}"
            state.session_counter += 1

            # Initialize session
            state.claude_sessions[session_id] = {
                "id": session_id,
                "status": "pending",
                "message": message,
                "directory": directory or os.getcwd(),
                "output": [],
                "created_at": time.time(),
                "error": None
            }

        # Start background thread to execute Claude Code
        thread = threading.Thread(
            target=_execute_claude_session,
            args=(session_id,),
            daemon=True
        )
        thread.start()

        return JSONResponse(content={
            "session_id": session_id,
            "status": "pending"
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@router.get("/api/chat/sessions")
async def list_chat_sessions():
    """List all chat sessions."""
    return JSONResponse(content={
        "sessions": list(state.claude_sessions.values())
    })


@router.get("/api/chat/session/{session_id}")
async def get_chat_session(session_id: str):
    """Get details of a specific chat session."""
    if session_id not in state.claude_sessions:
        return JSONResponse(
            content={"error": "Session not found"},
            status_code=404
        )

    return JSONResponse(content=state.claude_sessions[session_id])


def _execute_claude_session(session_id: str):
    """Execute a Claude Code session in the background."""
    session = state.claude_sessions[session_id]
    session["status"] = "running"

    try:
        # Check if claude-code is available
        claude_code_path = shutil.which("claude-code")

        if not claude_code_path:
            session["status"] = "error"
            session["error"] = "Claude Code not found. Please install it first."
            return

        # Execute claude-code with the user's message
        # Change to the specified directory first
        cwd = session.get("directory", os.getcwd())

        # Run claude-code with the message
        result = subprocess.run(
            [claude_code_path, session["message"]],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=300  # 5 minute timeout
        )

        # Capture stdout
        if result.stdout:
            session["output"].append({
                "type": "stdout",
                "content": result.stdout,
                "timestamp": time.time()
            })

        # Capture stderr if any
        if result.stderr:
            session["output"].append({
                "type": "stderr",
                "content": result.stderr,
                "timestamp": time.time()
            })

        # Check return code
        if result.returncode == 0:
            session["status"] = "completed"
        else:
            session["status"] = "error"
            session["error"] = f"Claude Code exited with code {result.returncode}"

    except subprocess.TimeoutExpired:
        session["status"] = "error"
        session["error"] = "Session timed out (5 minutes)"
    except FileNotFoundError:
        session["status"] = "error"
        session["error"] = "Claude Code executable not found"
    except Exception as e:
        session["status"] = "error"
        session["error"] = str(e)
