"""The snippet view's verbs — read, save one region, check, and the terminal it runs in — over
``flow_sdk.core.snippet`` and ``Shell``.

Thin on purpose: every rule (what a region is, how an edit is written back, how
a language runs) lives in the core module and is proven there by fast unit tests;
running is the file's own terminal (``Shell.belonging_to``), whose output streams as it
is printed. This file only moves values across HTTP.

Failures carry ``error_code`` in the body (see ``display.py``'s ``_fail``):
``NOT_FOUND``, ``NOT_A_SNIPPET``, ``STALE`` (the file was restructured since the
viewer read it — reload, never write by a stale position).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from flow_sdk.core.snippet import (
    SnippetCheckRequest,
    SnippetDoc,
    SnippetReadRequest,
    SnippetSaveRequest,
    SnippetTerminalRequest,
    check_snippet,
    edit_region,
    read_snippet,
    terminal_command,
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
    line = 1
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


@router.post("/api/v1/snippet/check")
async def snippet_check(req: SnippetCheckRequest):
    """What would stop the file before it does its job, in FILE lines — the viewer maps them onto
    its regions. A file with problems is still a success: the problems are the answer."""
    path = _existing(req.path)
    if isinstance(path, ApiFailResponse):
        return path
    found = await check_snippet(path, timeout_seconds=req.timeout_seconds)
    return ApiSuccessResponse(data={"path": str(path), "diagnostics": [d.model_dump() for d in found]})


@router.post("/api/v1/snippet/terminal")
async def snippet_terminal(req: SnippetTerminalRequest):
    """The file's own terminal — one per file (``snippet:<path>``), so its last run is still there
    on the next visit — and the command that runs the file in it. The viewer types the command
    through the terminal (``run-command``) and watches it there."""
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    path = _existing(req.path)
    if isinstance(path, ApiFailResponse):
        return path
    command = terminal_command(path)
    if command is None:
        return _fail("NOT_APPLICABLE", f"no runner for '{path.suffix}' files")
    try:
        shell = await Shell.belonging_to(f"snippet:{path}", workdir=str(path.parent), name=f"{path.name} · snippet")
    except RuntimeError as exc:
        return ApiFailResponse(message=str(exc))
    return ApiSuccessResponse(data={"shell_id": str(shell.id), "command": command, "path": str(path)})
