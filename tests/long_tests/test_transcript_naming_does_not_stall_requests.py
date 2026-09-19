"""A live session's transcript must not stall unrelated requests through worker naming.

Slow-open RCA (2026-09-16): resuming a session on a long-running backend took
35-100s. Worker naming bound every opened process to its transcript for title
updates, and a process whose transcript is not on disk (never written, moved, or
from another machine) fell back to the WHOLE ``projects`` dir. A live session
appending to its transcript then refreshed all of them - DB load plus a write
transaction each - and requests' own DB awaits queued behind that work. On the
live oss instance 44 of 53 running Claude processes had no transcript on disk.

Entered only through seams the product uses: processes are opened the way
resume/open does (``save`` then ``reconcile_name``), the live transcript is a real
file a background thread appends to, and its changes are delivered the way the
FSOp transcript watcher does (``transcript_streamer_registry.notify_change`` at
the watcher's cadence). The cost is measured as a request feels it - a burst of
sequential DB awaits - with the session quiet vs writing.
"""

import asyncio
import json
import threading
import time

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.agentic_process.naming.state import SessionNameState
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

TRANSCRIPTLESS_PROCESSES = 60
WARMUP_SECONDS = 2.0
WRITE_INTERVAL_SECONDS = 0.01
#: The FSOp transcript watcher coalesces raw writes into debounced batches;
#: deliver at that order of cadence rather than once per write.
NOTIFY_INTERVAL_SECONDS = 0.4
DB_AWAITS = 30


@pytest.fixture(autouse=True)
def claude_home(tmp_path, monkeypatch):
    # ``.claude`` in the path is how a transcript is attributed to its vendor.
    directory = str(tmp_path / ".claude")
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", directory)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", directory)
    reset_instance_settings()
    yield
    reset_instance_settings()


def _transcript(sid: str):
    path = get_instance_settings().claude_projects_dir / "-repo" / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {"type": "user", "message": {"role": "user", "content": "keep working"},
         "uuid": mint_uuid(), "sessionId": sid, "cwd": "/repo", "isSidechain": False,
         "entrypoint": "sdk-cli", "timestamp": "2026-09-16T00:00:00Z"},
        {"type": "ai-title", "aiTitle": "Live session", "sessionId": sid},
    ]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


async def _open_running_process(sid: str) -> AgenticProcess:
    """Persist a running process and reconcile its name, as resume/open does."""
    process = AgenticProcess(
        id=mint_uuid(), worker_type=WorkerType.CLAUDE_CODE_CLI, status=ProcessStatus.RUNNING,
        session_id=sid, workdir="/repo",
        naming_state=SessionNameState(session_id=sid, fallback="keep working"),
    )
    await process.save()
    await process.reconcile_name()
    return process


class _LiveSession:
    """A working session: appends to its transcript while the watcher delivers the changes."""

    def __init__(self, path, sid):
        self._path, self._sid = path, sid
        self._stop = threading.Event()
        self._writer = threading.Thread(target=self._write, daemon=True)
        self._notifier: asyncio.Task | None = None

    def _write(self):
        n = 0
        while not self._stop.is_set():
            n += 1
            line = {"type": "assistant", "uuid": mint_uuid(), "sessionId": self._sid, "cwd": "/repo",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": f"step {n}"}]}}
            with self._path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(line) + "\n")
            time.sleep(WRITE_INTERVAL_SECONDS)

    async def _notify(self):
        while True:
            await transcript_streamer_registry.notify_change(self._path)
            await asyncio.sleep(NOTIFY_INTERVAL_SECONDS)

    async def __aenter__(self):
        self._writer.start()
        self._notifier = asyncio.create_task(self._notify())
        return self

    async def __aexit__(self, *exc):
        self._stop.set()
        self._writer.join()
        self._notifier.cancel()
        try:
            await self._notifier
        except asyncio.CancelledError:
            pass


async def _db_burst(probe_id: str) -> float:
    """Seconds for a request-shaped burst of sequential DB awaits."""
    start = time.monotonic()
    for _ in range(DB_AWAITS):
        await AgenticProcess.get_by_id(probe_id)
    return time.monotonic() - start


async def test_live_transcript_does_not_stall_request_awaits():
    live_sid = mint_uuid()
    live_path = _transcript(live_sid)
    await _open_running_process(live_sid)
    probe = [await _open_running_process(mint_uuid()) for _ in range(TRANSCRIPTLESS_PROCESSES)][-1]

    await asyncio.sleep(WARMUP_SECONDS)
    quiet = await _db_burst(probe.id)

    async with _LiveSession(live_path, live_sid):
        await asyncio.sleep(WARMUP_SECONDS)
        live = await _db_burst(probe.id)

    timings = f"session quiet={quiet * 1000:.0f}ms, session writing={live * 1000:.0f}ms"
    print(timings)
    assert live < 3 * quiet + 0.05, (
        f"{DB_AWAITS} DB awaits stall while one session writes its transcript: {timings}"
    )
