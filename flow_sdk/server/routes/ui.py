"""
UI serving routes for the local server.
"""

import sys
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse

router = APIRouter()


def _frozen_static_bases() -> list[Path]:
    """Candidate roots that may hold ``server/static`` in a PyInstaller bundle.

    Covers ``sys._MEIPASS`` resolving to either the bundle/``_internal`` dir or
    the exe dir across PyInstaller versions/onedir layouts (the built UI is added
    via ``--add-data ...;server/static``, landing under ``_internal``).
    """
    import os
    bases: list[Path] = []
    mp = getattr(sys, '_MEIPASS', None)
    if mp:
        bases += [Path(mp), Path(mp) / '_internal']
    exedir = Path(os.path.dirname(sys.executable))
    bases += [exedir, exedir / '_internal']
    return bases


def _find_static_file(filename: str) -> Path | None:
    """Find a static file, checking ui/dist first then static/."""
    if getattr(sys, 'frozen', False):
        for base in _frozen_static_bases():
            path = base / 'server' / 'static' / filename
            if path.exists():
                return path
        return None

    base = Path(__file__).parent.parent
    repo_root = base.parent
    for path_candidate in [repo_root / 'ui' / 'dist' / filename, base / 'static' / filename]:
        if path_candidate.exists():
            return path_candidate
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
        # PyInstaller bundle — the built UI is under server/static (added via
        # --add-data). Try every plausible base since _MEIPASS layout varies.
        return [b / 'server' / 'static' / 'index.html' for b in _frozen_static_bases()]
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
    candidates = _get_index_candidates()
    for candidate in candidates:
        if candidate.exists():
            return serve_index_html(candidate.read_text())
    import logging
    logging.getLogger("flow_sdk.server.ui").warning(
        "UI index.html not found. frozen=%s MEIPASS=%s exe=%s tried=%s",
        getattr(sys, "frozen", False), getattr(sys, "_MEIPASS", None),
        sys.executable, [str(c) for c in candidates],
    )
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
