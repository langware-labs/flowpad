"""GET the framed PTY stream for a shell — powers attach-time history replay.

The frontend fetches this on terminal mount, replays it through a headless
xterm at the recorded sizes (resize frames), serializes, and writes the
result into the visible terminal before attaching for live output. See
``flow_sdk/compute/providers/desktop/pty_stream_file.py`` for the format.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.responses.response import ApiSuccessResponse

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

    frames = PtyStreamFile(path=path).read_frames()
    if frames is None:
        return JSONResponse({"error": "no stream recorded"}, status_code=404)
    # Standard envelope — the ts_sdk axios interceptor unwraps response.data.data
    return ApiSuccessResponse(data=frames)
