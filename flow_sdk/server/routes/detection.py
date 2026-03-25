"""
Claude Code detection routes for the local server.
"""

import shutil

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/api/claude-code/detect")
async def detect_claude_code():
    """Detect if Claude Code is installed and return its path."""
    try:
        # Try to find Claude Code executable
        claude_code_path = shutil.which("claude-code")

        if claude_code_path:
            return JSONResponse(content={
                "found": True,
                "path": claude_code_path
            })
        else:
            return JSONResponse(content={
                "found": False,
                "path": None
            })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)
