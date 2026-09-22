"""GET the framed PTY stream for a shell — powers attach-time history replay.

The frontend fetches this on terminal mount, replays it through a headless
xterm at the recorded sizes (resize frames), serializes, and writes the
result into the visible terminal before attaching for live output. See
``flow_sdk/compute/providers/desktop/pty_stream_file.py`` for the format.
"""

from __future__ import annotations

import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk import toplog
from flow_sdk.responses.response import ApiResponseStatus

router = APIRouter()


@router.get("/shell/{shell_id}/pty-stream")
async def get_pty_stream(shell_id: str) -> JSONResponse:
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

    t0 = time.monotonic()
    frames = PtyStreamFile(path=path).read_frames()
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
            "pty", "stream_read shell=%s bytes=%s events=%s ms=%.0f render_ms=%.0f",
            shell_id, path.stat().st_size, len(frames["events"]),
            (t_read - t0) * 1000, (time.monotonic() - t_read) * 1000,
        )
    return response
