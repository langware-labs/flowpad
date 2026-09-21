"""GET /shell/{id}/pty-stream must not re-encode the replay payload per event.

Proven on prod 2026-09-20 with a loop-stall stack sampler (main-thread stack
captured mid-stall) and a two-way toggle on a 24MB / 101k-event shell:

  route returns ApiSuccessResponse(data=frames) -> FastAPI serialize_response
  -> ApiResponse.model_dump -> fastapi.jsonable_encoder walks every event in
  Python, then JSONResponse.render json.dumps the result — all on the event loop.

    OFF  req 0.66-0.77s  loop stall 511-553ms  PTY output_delayed 572-588ms
    ON   req 0.19-0.35s  loop stall none       PTY output_delayed none/323/none
    OFF  req 0.73-1.16s  loop stall 533-726ms  PTY output_delayed 701-1215ms

The frames come out of ``json.loads`` — already plain JSON types — so that
walk changes nothing in the bytes. It only freezes every live terminal on the
backend while it runs, once per terminal attach / remount / tab switch.

PROXY NOTE: this asserts the MECHANISM (per-event Python encoding ran during
the request), not the latency. The loop stall itself is proven by the prod
toggle above; a wall-clock bound here would be a flaky timing test.

No mocks: the shell record and stream file are created exactly as the spawn
path creates them (pty_actions.py), the request goes through the real route
and FastAPI's real response serialization over ASGI in-process, and the count
is OBSERVED with sys.setprofile — nothing is patched.
"""

from __future__ import annotations

import sys
import uuid

import httpx
import pytest
from fastapi import FastAPI
from fastapi import encoders as fastapi_encoders

from flow_sdk.builtin.shell import ShellStatus, shell_pty_stream_path
from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.server.routes.pty_stream import router as pty_stream_router

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_EVENTS = 2000


def _spawn_like_shell_with_history(n_chunks: int) -> str:
    """What pty_actions does at spawn, then n_chunks of terminal output."""
    shell_id = str(uuid.uuid4())
    record = FSRecord(
        type="shell",
        id=shell_id,
        pty_pid=shell_id,
        workdir="/tmp",
        name="replay-probe",
        status=ShellStatus.RUNNING.value,
    )
    record.save()
    stream = PtyStreamFile(path=shell_pty_stream_path(shell_id, shell_id), cols=120, rows=40)
    for seq in range(1, n_chunks + 1):
        stream.write(f"line {seq}: some terminal output\r\n".encode(), seq)
    return shell_id


@pytest.mark.asyncio
async def test_pty_stream_replay_is_not_reencoded_event_by_event(initialize_test_db) -> None:
    shell_id = _spawn_like_shell_with_history(_EVENTS)

    app = FastAPI()
    app.include_router(pty_stream_router, prefix="/api/v1")

    target = fastapi_encoders.jsonable_encoder.__code__
    calls = 0

    def _count(frame, event, _arg):
        nonlocal calls
        if event == "call" and frame.f_code is target:
            calls += 1

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        sys.setprofile(_count)
        try:
            resp = await client.get(f"/api/v1/shell/{shell_id}/pty-stream")
        finally:
            sys.setprofile(None)

    assert resp.status_code == 200, resp.text[:300]
    body = resp.json()
    assert body["status"] == "SUCCESS"
    n_events = len(body["data"]["events"])
    assert n_events >= _EVENTS, f"replay lost events: {n_events} < {_EVENTS}"

    assert calls < n_events, (
        f"serving the replay walked the payload through fastapi.jsonable_encoder "
        f"{calls} times for {n_events} events (~{calls / n_events:.1f} per event) — "
        f"per-event Python re-encoding of data that is already JSON, on the event "
        f"loop. On prod's 101k-event shell that is the 511-726ms stall that froze "
        f"every live terminal."
    )
