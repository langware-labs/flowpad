"""
Directory management routes for the local server.
"""

import os
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/api/directory/current")
async def get_current_directory():
    """Get the current working directory."""
    return JSONResponse(content={"path": os.getcwd()})


@router.post("/api/directory/select")
async def select_directory(data: dict):
    """Validate and return directory info (doesn't change CWD)."""
    try:
        path = data.get("path")
        if not path:
            return JSONResponse(
                content={"error": "Path is required"},
                status_code=400
            )

        path_obj = Path(path).resolve()
        if not path_obj.exists():
            return JSONResponse(
                content={"error": "Directory does not exist"},
                status_code=400
            )
        if not path_obj.is_dir():
            return JSONResponse(
                content={"error": "Path is not a directory"},
                status_code=400
            )

        return JSONResponse(content={
            "path": str(path_obj),
            "exists": True,
            "is_dir": True
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)
