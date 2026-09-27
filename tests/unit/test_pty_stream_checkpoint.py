"""A cold terminal open replays a checkpoint plus the tail, not the whole session.

Measured 2026-09-27 on a production build: a cold open of a 3.9 MB-serialized
session took 1.8-2.2 s — 0.8 s of it the headless replay of every frame. A client
that has replayed posts the result back as a checkpoint ("the terminal after
absolute frame N, at cols x rows"); the next cold open fetches the checkpoint and
only the frames after it (docs/navigation/dock-loading.md, step 7).

Frame numbers are ABSOLUTE (the header's ``base`` counts what front truncation
dropped), so a checkpoint survives the rolling cap; one older than the retained
window, or newer than the file, is not used — the full stream is served instead.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import FastAPI

from flow_sdk.builtin.shell import ShellStatus, shell_pty_stream_path
from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.server.routes.pty_stream import router as pty_stream_router

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _stream(tmp_path, max_size_bytes: int = 30 * 1024 * 1024) -> PtyStreamFile:
    return PtyStreamFile(path=tmp_path / "s.pty", cols=80, rows=24, max_size_bytes=max_size_bytes)


def _write(stream: PtyStreamFile, n: int, start: int = 1) -> None:
    for seq in range(start, start + n):
        stream.write(f"line {seq}\r\n".encode(), seq)


def test_no_checkpoint_serves_the_whole_recording(tmp_path) -> None:
    s = _stream(tmp_path)
    _write(s, 10)
    frames = s.read_frames_since_checkpoint()
    assert frames is not None and "checkpoint" not in frames
    assert frames["base"] == 0 and len(frames["events"]) == 10


def test_a_checkpoint_serves_itself_and_only_the_frames_after_it(tmp_path) -> None:
    s = _stream(tmp_path)
    _write(s, 10)
    s.write_checkpoint(frame=6, cols=80, rows=24, serialized="SCREEN", last_seq=6)
    frames = s.read_frames_since_checkpoint()
    assert frames["checkpoint"] == {"cols": 80, "rows": 24, "last_seq": 6, "serialized": "SCREEN"}
    assert frames["base"] == 6
    assert [e[2] for e in frames["events"]] == [7, 8, 9, 10]


def test_a_checkpoint_at_the_end_serves_no_tail(tmp_path) -> None:
    s = _stream(tmp_path)
    _write(s, 5)
    s.write_checkpoint(frame=5, cols=80, rows=24, serialized="SCREEN", last_seq=5)
    frames = s.read_frames_since_checkpoint()
    assert frames["events"] == [] and frames["checkpoint"]["serialized"] == "SCREEN"


def test_a_checkpoint_from_the_future_is_not_used(tmp_path) -> None:
    s = _stream(tmp_path)
    _write(s, 5)
    s.write_checkpoint(frame=99, cols=80, rows=24, serialized="OTHER RECORDING", last_seq=99)
    frames = s.read_frames_since_checkpoint()
    assert "checkpoint" not in frames and len(frames["events"]) == 5


def test_frame_numbers_survive_front_truncation(tmp_path) -> None:
    s = _stream(tmp_path, max_size_bytes=4096)
    _write(s, 400)  # far past the cap: the front is dropped, more than once
    frames = s.read_frames()
    assert frames["base"] > 0, "truncation dropped frames but did not advance base"
    # The last retained output frame is still absolute frame (base + len - 1):
    # every seq written is one frame, so the newest seq pins the numbering.
    last = frames["base"] + len(frames["events"])
    s.write_checkpoint(frame=last - 3, cols=80, rows=24, serialized="SCREEN", last_seq=397)
    tail = s.read_frames_since_checkpoint()
    assert [e[2] for e in tail["events"]] == [398, 399, 400]


def test_a_checkpoint_older_than_the_retained_window_is_not_used(tmp_path) -> None:
    s = _stream(tmp_path, max_size_bytes=4096)
    _write(s, 20)
    s.write_checkpoint(frame=3, cols=80, rows=24, serialized="OLD", last_seq=3)
    _write(s, 400, start=21)  # truncation drops frame 3 and far beyond
    frames = s.read_frames_since_checkpoint()
    assert "checkpoint" not in frames, "a checkpoint before the retained window was used"


def test_delete_removes_the_checkpoint_with_the_recording(tmp_path) -> None:
    s = _stream(tmp_path)
    _write(s, 3)
    s.write_checkpoint(frame=3, cols=80, rows=24, serialized="SCREEN", last_seq=3)
    s.delete()
    assert s.read_checkpoint() is None


@pytest.mark.asyncio
async def test_route_round_trip(initialize_test_db) -> None:
    shell_id = str(uuid.uuid4())
    FSRecord(
        type="shell", id=shell_id, pty_pid=shell_id, workdir="/tmp", name="ck", status=ShellStatus.RUNNING.value
    ).save()
    stream = PtyStreamFile(path=shell_pty_stream_path(shell_id, shell_id), cols=100, rows=30)
    _write(stream, 8)

    app = FastAPI()
    app.include_router(pty_stream_router, prefix="/api/v1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        put = await client.post(
            f"/api/v1/shell/{shell_id}/pty-stream/checkpoint",
            json={"frame": 5, "cols": 100, "rows": 30, "last_seq": 5, "serialized": "SCREEN"},
        )
        assert put.status_code == 200, put.text
        full = (await client.get(f"/api/v1/shell/{shell_id}/pty-stream")).json()["data"]
        since = (await client.get(f"/api/v1/shell/{shell_id}/pty-stream?since=checkpoint")).json()["data"]

    assert "checkpoint" not in full and len(full["events"]) == 8
    assert since["checkpoint"]["serialized"] == "SCREEN"
    assert [e[2] for e in since["events"]] == [6, 7, 8]


def test_closing_a_shell_removes_its_checkpoint_with_its_recording(initialize_test_db) -> None:
    from flow_sdk.builtin.shell import close_shell_record

    shell_id = str(uuid.uuid4())
    record = FSRecord(
        type="shell", id=shell_id, pty_pid=shell_id, workdir="/tmp", name="ck", status=ShellStatus.RUNNING.value
    )
    record.save()
    stream = PtyStreamFile(path=shell_pty_stream_path(shell_id, shell_id), cols=80, rows=24)
    _write(stream, 3)
    stream.write_checkpoint(frame=3, cols=80, rows=24, serialized="SCREEN", last_seq=3)

    close_shell_record(record)

    assert not stream.exists
    assert stream.read_checkpoint() is None, "a closed shell left its checkpoint (the serialized screen) behind"
