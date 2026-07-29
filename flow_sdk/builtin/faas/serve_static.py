"""Static byte-serving for app folders — the one implementation.

Before this module the backend had two near-identical copies of "serve a file
out of an app folder" (``MicroApp.view`` and ``MicroApp.view_external_domain``)
and a third, unrelated one for the console shell
(``server/routes/ui.py:serve_index_html``). They disagreed on exactly the thing
that matters for an app talking back to us: only the console got the runtime
API-origin injection.

``serve_app_bytes`` is now the single path, so a served app inherits the backend
that served it for free — the same mechanism, local or cloud.
"""

from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path

import anyio
from bs4 import BeautifulSoup
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response, StreamingResponse

# Set before the app bundle loads; ``||`` so a host that already pinned the
# override (the Electron preload) keeps winning. ``load_config.ts`` honours this
# ABOVE the compile-time ``__API_URL__`` define.
API_ORIGIN_SNIPPET = (
    "<script>globalThis.__FLOWPAD_API_URL__="
    "globalThis.__FLOWPAD_API_URL__||window.location.origin;</script>"
)

_CHUNK_SIZE = 8192


class AppNotBuilt(HTTPException):
    """The app's serving root does not exist yet — it has not been built.

    A distinct 404 rather than a generic one: "you never ran the build" is a
    different user action from "that file isn't in this app", and the display
    shows a build CTA for the former.
    """

    def __init__(self, root: Path | str) -> None:
        super().__init__(status_code=404, detail=f"App is not built yet (no {root})")


def inject_api_origin(html: str) -> str:
    """Point the page's SDK at the backend that served it. Idempotent."""
    if API_ORIGIN_SNIPPET in html:
        return html
    idx = html.lower().find("<head>")
    at = idx + len("<head>") if idx != -1 else 0  # no <head> → prepend, still before the bundle
    return html[:at] + API_ORIGIN_SNIPPET + html[at:]


def inject_base_tag(html: str, base_url: str) -> str:
    """Inject ``<base href=...>`` into ``<head>``, creating the head if needed."""
    soup = BeautifulSoup(html, "html.parser")

    head = soup.head
    if not head:
        head = soup.new_tag("head")
        if soup.html:
            soup.html.insert(0, head)
        else:
            html_tag = soup.new_tag("html")
            soup.insert(0, html_tag)
            html_tag.insert(0, head)

    if not head.find("base"):
        head.insert(0, soup.new_tag("base", href=base_url))

    # str(), not prettify(): re-indenting the whole document to insert one tag
    # is work nobody asked for, and its whitespace rewriting reaches inside
    # <pre> and inline <script> where it can change what the page means.
    return str(soup)


def resolve_within(root: Path, sub_path: str) -> Path:
    """Resolve *sub_path* under *root*, refusing anything that escapes it.

    The URL layer decodes ``..%2F..`` into literal ``..`` segments before it
    reaches us, so this resolve-then-compare is the only defense. Mirrors
    ``AppCodebase.public_file_path``, but takes the root explicitly — an
    artifact-backed app serves straight out of its build output, with no
    ``public/`` convention imposed on it.
    """
    root = root.resolve()
    candidate = (root / Path(sub_path or "")).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(status_code=403, detail="Invalid file path")
    return candidate


def _etag(file_path: Path) -> str:
    """Validator derived from stat, not content.

    Hashing the bytes meant reading the entire file on every request — including
    the requests we then answer 304, i.e. paying full I/O to say "nothing
    changed". mtime+size is what Starlette's own FileResponse uses.
    """
    stat = file_path.stat()
    return hashlib.md5(f"{stat.st_mtime_ns}-{stat.st_size}".encode()).hexdigest()


async def _file_iterator(file_path: Path):
    async with await anyio.open_file(str(file_path), "rb") as f:
        while True:
            chunk = await f.read(_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk


def _base_url_for(request: Request, api_url_scheme: str | None) -> str:
    request_url = request.url
    if api_url_scheme and request_url.scheme != api_url_scheme:
        request_url = request_url.replace(scheme=api_url_scheme)
    base_url = str(request_url).split("?")[0]
    return base_url if base_url.endswith("/") else base_url + "/"


async def serve_app_bytes(
    root: Path | str,
    sub_path: str | None,
    request: Request,
    *,
    inject_base: bool = True,
    api_url_scheme: str | None = None,
) -> Response:
    """Serve one file out of *root*, falling back to its ``index.html``.

    ``inject_base`` is the one behavioural difference between the callers: a
    micro-app served under a console API path needs ``<base>`` so its relative
    asset URLs resolve, while one served on its own domain must not have its
    document rewritten. The API-origin injection is unconditional — it is what
    makes the page's SDK reach the right backend.
    """
    root_path = Path(root)
    if not root_path.exists() or not root_path.is_dir():
        raise AppNotBuilt(root_path)

    requested_file = resolve_within(root_path, sub_path or "index.html")

    if not (requested_file.exists() and requested_file.is_file()):
        index_file = root_path / "index.html"
        if not index_file.exists():
            return Response(status_code=404, content=f"File not found: {requested_file}")
        requested_file = index_file

    if requested_file.suffix == ".html":
        # Async read to match the asset path below: every SPA deep link lands
        # here on index.html, so a blocking read would stall the loop routinely.
        async with await anyio.open_file(str(requested_file), "r") as f:
            html = await f.read()
        if inject_base:
            html = inject_base_tag(html, _base_url_for(request, api_url_scheme))
        return HTMLResponse(content=inject_api_origin(html))

    etag = _etag(requested_file)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    mime_type, _ = mimetypes.guess_type(str(requested_file))
    response = StreamingResponse(
        content=_file_iterator(requested_file),
        media_type=mime_type or "application/octet-stream",
    )
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


# `inject_base_tag` and `resolve_within` are deliberately absent: they are steps
# of `serve_app_bytes`, and exporting them invites a second caller to assemble
# its own serving path out of the pieces — the exact divergence this module was
# written to end.
__all__ = [
    "API_ORIGIN_SNIPPET",
    "AppNotBuilt",
    "inject_api_origin",
    "serve_app_bytes",
]
