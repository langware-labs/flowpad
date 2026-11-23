"""
UI serving routes for the local server.
"""

import json
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse

router = APIRouter()


def _repo_root_for_ui(server_dir: Path) -> Path:
    sdk_root = server_dir.parent
    project_root = sdk_root.parent
    if (project_root / 'ui').exists():
        return project_root
    return sdk_root


def _find_static_file(filename: str, *, prefer_public: bool = False) -> Path | None:
    """Find a static file across dev, build, and packaged locations."""
    if getattr(sys, 'frozen', False):
        base = Path(sys._MEIPASS) / 'server'
    else:
        base = Path(__file__).parent.parent

    repo_root = _repo_root_for_ui(base)
    candidates = [
        repo_root / 'ui' / 'dist' / filename,
        repo_root / 'ui' / 'public' / filename,
        base / 'static' / filename,
    ]
    if prefer_public:
        candidates = [
            repo_root / 'ui' / 'public' / filename,
            repo_root / 'ui' / 'dist' / filename,
            base / 'static' / filename,
        ]
    for path_candidate in candidates:
        path = path_candidate
        if path.exists():
            return path
    return None


def _opens_the_app(request: Request) -> bool:
    """A top-level document load of the app from outside it, on a loopback host (Sec-Fetch-* are the browser's own)."""
    from flow_sdk.utils.networking import is_loopback  # noqa: PLC0415

    headers = request.headers
    return (
        request.method in ("GET", "HEAD")
        and headers.get("sec-fetch-site") in ("none", "cross-site", "same-site")
        and headers.get("sec-fetch-mode") == "navigate"
        and headers.get("sec-fetch-dest") == "document"
        and is_loopback(request.url.hostname)
    )


def serve_index_html(html: str, request: Request | None = None) -> HTMLResponse:
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

    The injection itself lives in ``builtin/faas/serve_static`` so served apps
    get the identical treatment from the identical string — the console and an
    app it built should not be able to drift on how they find their backend.
    """
    from flow_sdk.builtin.faas.serve_static import inject_api_origin, inject_state_key  # noqa: PLC0415
    from flow_sdk.server import page_state  # noqa: PLC0415

    # The app's own key goes to the app's window opened from outside it: typed, bookmarked, the OS launch, the
    # reload button (`Sec-Fetch-Site: none`) or a link in another app, page or tool (`cross-site`/`same-site`).
    # What the link names still asks first (the Allow cards), and the opener cannot read the window it opened.
    # A page's own `fetch('/')` or `window.open('/')` is same-origin, so no page can take the app's reach.
    if request is not None and page_state.enforced() and _opens_the_app(request):
        return HTMLResponse(
            content=inject_state_key(inject_api_origin(html), page_state.app_key()), headers={"Cache-Control": "no-store"}
        )
    return HTMLResponse(content=inject_api_origin(html))


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
        repo_root = _repo_root_for_ui(server_dir)
        return [
            repo_root / 'ui' / 'dist' / 'index.html',
            server_dir / 'static' / 'index.html',
        ]


@router.get("/", response_class=HTMLResponse)
async def serve_ui(request: Request):
    """Serve the main UI.

    Looks for index.html in priority order:
    1. ui/dist/index.html (Vite build output — matches bundled assets)
    2. server/static/index.html (production build via build_ui.py)
    """
    for candidate in _get_index_candidates():
        if candidate.exists():
            # encoding= on purpose: the shell is UTF-8, the host codepage is not.
            return serve_index_html(candidate.read_text(encoding="utf-8"), request)
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


def _csp_domains(value: object) -> str:
    if not isinstance(value, list):
        return ""
    domains = [str(v).strip() for v in value if isinstance(v, str) and v.strip()]
    return " ".join(domains)


def _sandbox_csp(raw: str | None) -> str:
    try:
        config = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        config = {}
    if not isinstance(config, dict):
        config = {}

    connect = _csp_domains(config.get("connectDomains")) or "'none'"
    resources = _csp_domains(config.get("resourceDomains"))
    frames = _csp_domains(config.get("frameDomains"))
    base_uri = _csp_domains(config.get("baseUriDomains")) or "'self'"

    resource_suffix = f" {resources}" if resources else ""
    resource_src = f"'unsafe-inline' data: blob:{resource_suffix}"
    return "; ".join(
        [
            "default-src 'none'",
            f"script-src 'unsafe-inline'{resource_suffix}",
            f"style-src {resource_src}",
            f"img-src data: blob:{resource_suffix}",
            f"font-src data:{resource_suffix}",
            f"media-src data: blob:{resource_suffix}",
            f"connect-src {connect}",
            f"frame-src about: data: blob:{(' ' + frames) if frames else ''}",
            f"base-uri {base_uri}",
            "form-action 'none'",
        ]
    )


@router.get("/mcp-sandbox/sandbox_proxy.html")
async def mcp_sandbox_proxy(request: Request):
    path = _find_static_file("sandbox_proxy.html", prefer_public=True)
    if not path:
        return HTMLResponse(content="not found", status_code=404)
    return HTMLResponse(
        content=path.read_text(),
        headers={
            "Content-Security-Policy": _sandbox_csp(request.query_params.get("csp")),
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Content-Type-Options": "nosniff",
        },
    )
