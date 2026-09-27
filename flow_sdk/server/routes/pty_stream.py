"""GET the framed PTY stream for a shell — powers attach-time history replay.

The frontend fetches this on terminal mount, replays it through a headless
xterm at the recorded sizes (resize frames), serializes, and writes the
result into the visible terminal before attaching for live output. See
``flow_sdk/compute/providers/desktop/pty_stream_file.py`` for the format.
"""

from __future__ import annotations

import asyncio

import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flow_sdk import toplog
from flow_sdk.responses.response import ApiResponseStatus

router = APIRouter()


def _stream_file(shell_id: str):
    """The shell's current recording, or a 404 response."""
    from flow_sdk.builtin.shell import get_shell_record, shell_pty_stream_path
    from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile

    record = get_shell_record(shell_id)
    if record is None:
        return JSONResponse({"error": "shell not found"}, status_code=404)
    pty_pid = record.__dict__.get("pty_pid")
    if not pty_pid:
        return JSONResponse({"error": "shell has no pty"}, status_code=404)
    try:
        path = shell_pty_stream_path(record.id, pty_pid)
    except ValueError:
        return JSONResponse({"error": "shell has no pty"}, status_code=404)
    return PtyStreamFile(path=path)


@router.get("/shell/{shell_id}/pty-stream")
async def get_pty_stream(shell_id: str, since: str | None = None) -> JSONResponse:
    """The recording. ``since=checkpoint``: a stored replay checkpoint plus only
    the frames after it, when one is usable (the full stream otherwise) — a cold
    terminal open then replays the tail, not the session (dock-loading, step 7)."""
    stream = _stream_file(shell_id)
    if isinstance(stream, JSONResponse):
        return stream
    path = stream._path

    t0 = time.monotonic()
    # Off the event loop: a long recording is tens of MB of JSON lines.
    read = stream.read_frames_since_checkpoint if since == "checkpoint" else stream.read_frames
    frames = await asyncio.to_thread(read)
    if frames is None:
        return JSONResponse({"error": "no stream recorded"}, status_code=404)
    t_read = time.monotonic()
    # The standard envelope (the ts_sdk axios interceptor unwraps
    # response.data.data), built by hand rather than via ApiSuccessResponse:
    # FastAPI runs a returned model through ``jsonable_encoder``, which walks
    # every event in Python on the event loop — the frames came out of
    # ``json.loads``, so one ``json.dumps`` gives the same bytes. See
    # tests/unit/test_pty_stream_route_does_not_reencode.py.
    response = JSONResponse({"status": ApiResponseStatus.SUCCESS.value, "message": "success", "data": frames})
    # Both halves run on the event loop — a slow line here stalls every
    # terminal on this backend, not just the one being mounted.
    if toplog.is_on("pty"):
        toplog.log(
            "pty", "stream_read shell=%s bytes=%s events=%s checkpoint=%s ms=%.0f render_ms=%.0f",
            shell_id, path.stat().st_size, len(frames["events"]), "checkpoint" in frames,
            (t_read - t0) * 1000, (time.monotonic() - t_read) * 1000,
        )
    return response


class PtyCheckpoint(BaseModel):
    """The replayed terminal after absolute frame ``frame``, at ``cols`` x ``rows``."""

    frame: int
    cols: int
    rows: int
    last_seq: int = 0
    serialized: str


@router.post("/shell/{shell_id}/pty-stream/checkpoint")
async def put_pty_checkpoint(shell_id: str, body: PtyCheckpoint) -> JSONResponse:
    """Store a client's replay result so the next cold open replays only the tail."""
    stream = _stream_file(shell_id)
    if isinstance(stream, JSONResponse):
        return stream
    try:
        await asyncio.to_thread(
            stream.write_checkpoint, body.frame, body.cols, body.rows, body.serialized, body.last_seq
        )
    except ValueError as exc:
        return JSONResponse({"status": ApiResponseStatus.FAIL.value, "message": str(exc)}, status_code=400)
    if toplog.is_on("pty"):
        toplog.log("pty", "stream_checkpoint shell=%s frame=%s kb=%.0f", shell_id, body.frame, len(body.serialized) / 1024)
    return JSONResponse({"status": ApiResponseStatus.SUCCESS.value, "message": "success", "data": {"frame": body.frame}})
