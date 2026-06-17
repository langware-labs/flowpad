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


def serve_index_html(html: str) -> HTMLResponse:
    """Return ``index.html`` with the runtime API origin injected — the single
    entry point for both ``/`` and the SPA deep-link fallback.

    Pins the served bundle's API base to *this* backend's own origin. The bundle
    bakes an ``__API_URL__`` at build time, but the SDK's ``load_config`` honours
    a runtime ``globalThis.__FLOWPAD_API_URL__`` ABOVE that compile-time define
    (the same hook the Electron shell and tests use). We set it to
    ``window.location.origin`` before the app bundle loads, so a bundle reached
    on any host:port talks to the backend that served it — regardless of the URL
    baked in. Without this, a bundle built/pinned for one port (e.g. 9007) but
    served by a backend on another (e.g. a 9008 dev instance) fires every request
    at the wrong — possibly stale — backend.

    Idempotent, and ``|| ...`` so a host that already set the override (Electron
    preload) wins.
    """
    snippet = (
        "<script>globalThis.__FLOWPAD_API_URL__="
        "globalThis.__FLOWPAD_API_URL__||window.location.origin;</script>"
    )
    if snippet not in html:
        idx = html.lower().find("<head>")
        at = idx + len("<head>") if idx != -1 else 0  # no <head> → prepend, still before the bundle
        html = html[:at] + snippet + html[at:]
    return HTMLResponse(content=html)


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
            return serve_index_html(candidate.read_text())
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
