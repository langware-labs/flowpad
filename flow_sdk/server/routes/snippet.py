"""The snippet view's three verbs — read, save one region, run — over ``flow_sdk.core.snippet``.

Thin on purpose: every rule (what a region is, how an edit is written back, how
a language runs, what a timeout does) lives in the core module and is proven
there by fast unit tests. This file only moves values across HTTP.

Failures carry ``error_code`` in the body (see ``display.py``'s ``_fail``):
``NOT_FOUND``, ``NOT_A_SNIPPET``, ``STALE`` (the file was restructured since the
viewer read it — reload, never write by a stale position).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from flow_sdk.core.snippet import (
    SnippetDoc,
    SnippetReadRequest,
    SnippetRunRequest,
    SnippetSaveRequest,
    edit_region,
    read_snippet,
    run_snippet,
)
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()


def _fail(error_code: str, message: str) -> ApiFailResponse:
    return ApiFailResponse(message=message, data={"error_code": error_code})


def _view(path: Path, doc: SnippetDoc) -> dict:
    """What the viewer renders: each region's kind, the text it edits, and the
    file line that text starts on — so the viewer numbers lines the way a
    traceback does."""
    regions = []
    line = doc.preamble.count("\n") + 1
    for i, r in enumerate(doc.regions):
        line += r.marker.count("\n")
        regions.append({"index": i, "kind": r.kind, "shown": r.shown, "line": line})
        line += r.body.count("\n")
    # `text` is the whole file, so the host can keep its raw copy in step
    # without refetching (which blanks the pane mid-typing).
    return {"path": str(path), "regions": regions, "text": doc.text()}


def _existing(raw: str) -> "Path | ApiFailResponse":
    path = Path(raw).expanduser().resolve()
    return path if path.is_file() else _fail("NOT_FOUND", f"no such file: {path}")


def _load(raw: str) -> "tuple[Path, SnippetDoc] | ApiFailResponse":
    path = _existing(raw)
    if isinstance(path, ApiFailResponse):
        return path
    doc = read_snippet(path)
    if doc is None:
        return _fail("NOT_A_SNIPPET", f"{path} has no '%% flowpad:snippet' marker")
    return path, doc


# read/save are plain `def`: file lock + fsync are blocking, so FastAPI runs them
# in its threadpool instead of on the event loop.
@router.post("/api/v1/snippet/read")
def snippet_read(req: SnippetReadRequest):
    loaded = _load(req.path)
    if isinstance(loaded, ApiFailResponse):
        return loaded
    return ApiSuccessResponse(data=_view(*loaded))


@router.post("/api/v1/snippet/save")
def snippet_save(req: SnippetSaveRequest):
    """Replace one region's text; answers the file as written. STALE covers every
    way the file moved under the viewer (see ``edit_region``)."""
    path = _existing(req.path)
    if isinstance(path, ApiFailResponse):
        return path
    try:
        doc = edit_region(path, req.index, req.kind, req.shown, base=req.base)
    except ValueError as e:
        return _fail("STALE", str(e))
    return ApiSuccessResponse(data=_view(path, doc))


@router.post("/api/v1/snippet/run")
async def snippet_run(req: SnippetRunRequest):
    """Run the file as written. Always succeeds at the HTTP level: a crash, a
    compile error and a timeout are all a ``CliResult`` to show, not a failure."""
    result = await run_snippet(Path(req.path), timeout_seconds=req.timeout_seconds)
    return ApiSuccessResponse(data=result.model_dump())
