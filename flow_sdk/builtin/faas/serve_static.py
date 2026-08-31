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
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response, StreamingResponse

from flow_sdk.compute.providers.compute_provider import is_e2b_public_host

# Set before the app bundle loads; ``||`` so a host that already pinned the
# override (the Electron preload) keeps winning. ``load_config.ts`` honours this
# ABOVE the compile-time ``__API_URL__`` define.
API_ORIGIN_SNIPPET = (
    "<script>globalThis.__FLOWPAD_API_URL__=globalThis.__FLOWPAD_API_URL__||window.location.origin;</script>"
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
    from bs4 import BeautifulSoup  # noqa: PLC0415 — an HTML parser is not startup work

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


def _browser_scheme(request: Request, api_url_scheme: str | None) -> str:
    """The scheme the BROWSER used to reach us — not the one we speak.

    ``<base>`` is resolved by the browser, so it has to name the origin the
    browser is actually on. Behind any TLS-terminating proxy that is not the
    scheme on our own socket, and getting it wrong is not cosmetic: an https
    page carrying ``<base href="http://…">`` has every relative asset blocked
    as mixed content, and the app renders blank.

    Three sources, most authoritative first:

    1. ``X-Forwarded-Proto`` — the standard announcement, believed when sent.
    2. An E2B public host. Its proxy sends **no** forwarded header at all (the
       request arrives with Host, Via and X-Cloud-Trace-Context and nothing
       else), so the Host is the only surviving evidence — and every url on
       that domain is https by construction (``sandbox_public_url``).
    3. The configured scheme, else our own. The escape hatch for a deployment
       whose proxy this function cannot recognise.

    ``inject_api_origin`` solves the same problem in the browser, where it is
    free (``window.location.origin``). ``<base>`` has to be built server-side,
    which is why it needs this.
    """
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if is_e2b_public_host(request.headers.get("host") or ""):
        return "https"
    return api_url_scheme or request.url.scheme


def _base_url_for(request: Request, api_url_scheme: str | None) -> str:
    request_url = request.url
    scheme = _browser_scheme(request, api_url_scheme)
    if request_url.scheme != scheme:
        request_url = request_url.replace(scheme=scheme)
    base_url = str(request_url).split("?")[0]
    return base_url if base_url.endswith("/") else base_url + "/"


#: What a built app's assets are allowed to sit in a browser cache for. An app
#: is a release; a file being iterated on is not, which is why the caller picks.
ASSET_CACHE_CONTROL = "public, max-age=3600"


async def serve_app_bytes(
    root: Path | str,
    sub_path: str | None,
    request: Request,
    *,
    inject_base: bool = True,
    api_url_scheme: str | None = None,
    fallback_index: bool = True,
    cache_control: str = ASSET_CACHE_CONTROL,
) -> Response:
    """Serve one file out of *root*, falling back to its ``index.html``.

    ``inject_base`` is the one behavioural difference between the callers: a
    micro-app served under a console API path needs ``<base>`` so its relative
    asset URLs resolve, while one served on its own domain must not have its
    document rewritten. The API-origin injection is unconditional — it is what
    makes the page's SDK reach the right backend.

    ``fallback_index`` and ``cache_control`` exist for the same reason: they are
    the two places where serving ONE FILE differs from serving an APP, and both
    defaults describe the app.

    * The index fallback is what makes a client-routed app work — ``/about`` is
      not a file, it is a route the JS inside ``index.html`` handles, so an
      unknown path must still return that document. A single served file has no
      router to hand over to, so the fallback would answer a missing file with
      an unrelated page: a 404 wearing a working page's clothes.
    * An hour of caching is right for a release and wrong for a file being
      edited, where the whole point is seeing the next version.
    """
    root_path = Path(root)
    if not root_path.exists() or not root_path.is_dir():
        raise AppNotBuilt(root_path)

    requested_file = resolve_within(root_path, sub_path or "index.html")

    if not (requested_file.exists() and requested_file.is_file()):
        index_file = root_path / "index.html"
        if not fallback_index or not index_file.exists():
            return Response(status_code=404, content=f"File not found: {requested_file}")
        requested_file = index_file

    if requested_file.suffix == ".html":
        # Async read to match the asset path below: every SPA deep link lands
        # here on index.html, so a blocking read would stall the loop routinely.
        # encoding= is not optional: app HTML is UTF-8, while the default here is
        # the host's locale codepage — cp1252 on a Windows box, where a UTF-8
        # Hebrew page decodes to mojibake or dies outright on an undefined byte.
        async with await anyio.open_file(str(requested_file), "r", encoding="utf-8") as f:
            html = await f.read()
        if inject_base:
            html = inject_base_tag(html, _base_url_for(request, api_url_scheme))
        # The document carries the same policy as its assets; without a header a
        # browser caches it heuristically and a cross-origin iframe never refetches.
        return HTMLResponse(content=inject_api_origin(html), headers={"Cache-Control": cache_control})

    etag = _etag(requested_file)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    mime_type, _ = mimetypes.guess_type(str(requested_file))
    response = StreamingResponse(
        content=_file_iterator(requested_file),
        media_type=mime_type or "application/octet-stream",
    )
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = cache_control
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
