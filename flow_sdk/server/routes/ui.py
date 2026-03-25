"""
UI serving routes for the local server.
"""

import sys
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse

router = APIRouter()


def _find_static_file(filename: str) -> Path | None:
    """Find a static file, checking ui/dist first then static/."""
    if getattr(sys, 'frozen', False):
        base = Path(sys._MEIPASS) / 'server'
    else:
        base = Path(__file__).parent.parent

    repo_root = base.parent
    for path_candidate in [repo_root / 'ui' / 'dist' / filename, base / 'static' / filename]:
        path = path_candidate
        if path.exists():
            return path
    return None


def _get_index_candidates() -> list[Path]:
    """Get index.html candidates in priority order."""
    if getattr(sys, 'frozen', False):
        # PyInstaller bundle — static dir has the built assets
        base_path = Path(sys._MEIPASS)
        return [
            base_path / 'server' / 'static' / 'index.html',
        ]
    else:
        server_dir = Path(__file__).parent.parent
        repo_root = server_dir.parent
        return [
            repo_root / 'ui' / 'dist' / 'index.html',
            server_dir / 'static' / 'index.html',
        ]


@router.get("/", response_class=HTMLResponse)
async def serve_ui():
    """Serve the main UI.

    Looks for index.html in priority order:
    1. ui/dist/index.html (Vite build output — matches bundled assets)
    2. server/static/index.html (production build via build_ui.py)
    """
    for candidate in _get_index_candidates():
        if candidate.exists():
            return HTMLResponse(content=candidate.read_text())
    return HTMLResponse(
        content="<h1>Flow UI not built. Run: python build_ui.py</h1>",
        status_code=404,
    )


@router.get("/favicon.ico")
async def favicon():
    path = _find_static_file("favicon.ico")
    if path:
        return FileResponse(path, media_type="image/x-icon")
    return HTMLResponse(status_code=404)


@router.get("/logo.png")
async def logo():
    path = _find_static_file("logo.png")
    if path:
        return FileResponse(path, media_type="image/png")
    return HTMLResponse(status_code=404)


@router.get("/ws-test.html")
async def ws_test():
    path = _find_static_file("ws-test.html")
    if path:
        return HTMLResponse(content=path.read_text())
    return HTMLResponse(status_code=404)
