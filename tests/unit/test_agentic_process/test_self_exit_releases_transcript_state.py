"""A worker that ends on its own releases its per-process transcript state.

``_LAST_BROADCAST_KEYS``, ``_PENDING_ENTRIES``, ``_DEBOUNCE_TASKS``,
``_REINDEX_WATERMARKS`` and ``_TRANSCRIPT_SIZE_AT_PROMPT`` are module-level by
design (the streamer hydrates a fresh AP per event), so only an explicit release
frees them. ``close()`` and ``delete()`` release; a worker that exits by itself
goes through neither — its rows stayed for the life of the server, and the
flush refused to drain lines the worker wrote just before exiting because the
row was no longer RUNNING (up to the buffer cap per process). The same release
drops the ``recovered`` flag (``pty_recovery``) that outlived its worker.

Every case enters through the watcher's real entry point
(``transcript_streamer_registry.notify_change``) and the real closure from
``_make_pty_exit_callback``; nothing in the release path is mocked. The spawn
clock is pinned so the exit lands on the plain STOPPED arm (a long-lived
worker), and the debounce window is set to zero so a flush settles within the
unit budget — the window's length is not what is under test.
"""

from __future__ import annotations

import asyncio
import json
import signal
from pathlib import Path
from unittest.mock import patch

import pytest

import flow_sdk.builtin.agentic_process.agentic_process as ap_module
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess, ProcessStatus
from flow_sdk.builtin.agentic_process.agentic_process import (
    _DEBOUNCE_TASKS,
    _LAST_BROADCAST_KEYS,
    _PENDING_ENTRIES,
    _REINDEX_WATERMARKS,
    _TRANSCRIPT_SIZE_AT_PROMPT,
)
from flow_sdk.builtin.agentic_process.naming.state import SessionNameState, reduce_name
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.server.pty_recovery import mark_recovered, was_recovered
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

SPAWNED_AT = 100.0
LONG_LIVED = SPAWNED_AT + 10 * ap_module.INSTANT_EXIT_WINDOW_SECONDS


@pytest.fixture(autouse=True)
def claude_home(tmp_path, monkeypatch):
    directory = str(tmp_path / ".claude")
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", directory)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", directory)
    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.fixture(autouse=True)
def fast_flush(monkeypatch):
    monkeypatch.setattr(AgenticProcess, "_DEBOUNCE_SECONDS", 0.0)

    async def _no_index(*_a, **_kw):  # session indexing on close needs a brain; unrelated here
        return None

    monkeypatch.setattr(ap_module, "_index_session_on_close", _no_index)


def _row(sid: str, kind: str, text: str) -> dict:
    if kind == "user":
        return {
            "type": "user",
            "message": {"role": "user", "content": text},
            "uuid": mint_uuid(),
            "sessionId": sid,
            "cwd": "/repo",
            "isSidechain": False,
            "entrypoint": "sdk-cli",
            "timestamp": "2026-10-10T00:00:00Z",
        }
    return {
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
        "uuid": mint_uuid(),
        "sessionId": sid,
        "cwd": "/repo",
        "timestamp": "2026-10-10T00:00:01Z",
    }


def _write_body(sid: str) -> Path:
    path = get_instance_settings().claude_projects_dir / "-repo" / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [_row(sid, "user", "go")] + [_row(sid, "assistant", "x" * 50) for _ in range(4)]
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def _append_last_lines(path: Path, sid: str, title: str) -> None:
    rows = [_row(sid, "assistant", "y" * 50) for _ in range(3)]
    rows.append({"type": "ai-title", "aiTitle": title, "sessionId": sid})
    with path.open("a", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r) + "\n" for r in rows))


async def _make_process(status: ProcessStatus = ProcessStatus.RUNNING, **overrides) -> tuple[AgenticProcess, Path]:
    sid = mint_uuid()
    path = _write_body(sid)
    fields = dict(
        id=mint_uuid(),
        worker_type=WorkerType.CLAUDE_CODE_CLI,
        status=status,
        workdir="/repo",
        session_id=sid,
        shell_id=mint_uuid(),
        pty_mode=True,
        naming_state=reduce_name(SessionNameState(), first_prompt="a prompt"),
    )
    fields.update(overrides)
    proc = AgenticProcess(**fields)
    await proc.save(notify=False)
    await proc.make_turn_session_adopter("test")(sid)
    return proc, path


async def _settle_flushes() -> None:
    await asyncio.gather(
        *(t for t in asyncio.all_tasks() if t.get_name().startswith("ap-flush-")),
        return_exceptions=True,
    )


async def _worker_exits(proc: AgenticProcess, exit_code: int | None, monkeypatch) -> None:
    """Fire the real exit closure the way the PTY layer does and await its state update."""
    scheduled: list = []
    real = asyncio.run_coroutine_threadsafe

    def _capturing(coro, loop):
        fut = real(coro, loop)
        scheduled.append(fut)
        return fut

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", _capturing)
    try:
        with patch.object(ap_module.time, "monotonic", return_value=SPAWNED_AT):
            on_exit = proc._make_pty_exit_callback()
        with patch.object(ap_module.time, "monotonic", return_value=LONG_LIVED):
            on_exit(exit_code)
        await asyncio.gather(*(asyncio.wrap_future(f) for f in scheduled))
    finally:
        monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", real)


def _held(key: str) -> dict[str, bool]:
    return {
        "broadcast_key": key in _LAST_BROADCAST_KEYS,
        "pending": key in _PENDING_ENTRIES,
        "debounce": key in _DEBOUNCE_TASKS,
        "watermark": key in _REINDEX_WATERMARKS,
        "prompt_offset": key in _TRANSCRIPT_SIZE_AT_PROMPT,
        "recovered": was_recovered(key),
    }


NOTHING = dict.fromkeys(("broadcast_key", "pending", "debounce", "watermark", "prompt_offset", "recovered"), False)


@pytest.mark.asyncio
async def test_last_lines_before_exit_release_everything_and_still_name(monkeypatch):
    proc, path = await _make_process()
    key = str(proc.id)
    mark_recovered(key)
    _REINDEX_WATERMARKS[key] = 3
    _TRANSCRIPT_SIZE_AT_PROMPT[key] = 7

    await transcript_streamer_registry.notify_change(path)
    await _settle_flushes()
    assert _held(key)["broadcast_key"], "the live phase must have broadcast once"

    _append_last_lines(path, proc.session_id, "Title from the last lines")
    await transcript_streamer_registry.notify_change(path)  # watcher first ...
    await _worker_exits(proc, 0, monkeypatch)  # ... then the exit lands
    await _settle_flushes()

    assert _held(key) == NOTHING
    row = await AgenticProcess.get_by_id(key)
    assert row.status == ProcessStatus.STOPPED.value
    assert row.name == "Title from the last lines", "the armed flush must finish, not be cancelled"


@pytest.mark.asyncio
async def test_last_lines_after_exit_are_not_parked(monkeypatch):
    proc, path = await _make_process()
    key = str(proc.id)

    await transcript_streamer_registry.notify_change(path)
    await _settle_flushes()

    await _worker_exits(proc, 0, monkeypatch)
    _append_last_lines(path, proc.session_id, "Late title")
    await transcript_streamer_registry.notify_change(path)  # the late event
    await _settle_flushes()

    assert _held(key) == NOTHING
    assert (await AgenticProcess.get_by_id(key)).name == "Late title"


@pytest.mark.asyncio
async def test_recoverable_signal_keeps_state_for_the_respawn(monkeypatch):
    proc, path = await _make_process()
    key = str(proc.id)
    mark_recovered(key)

    await transcript_streamer_registry.notify_change(path)
    await _settle_flushes()
    _REINDEX_WATERMARKS[key] = 5

    await _worker_exits(proc, -int(signal.SIGTERM), monkeypatch)
    await _settle_flushes()

    held = _held(key)
    assert held["broadcast_key"] and held["watermark"] and held["recovered"]
    assert (await AgenticProcess.get_by_id(key)).status == ProcessStatus.RUNNING.value
    ap_module._release_process_transcript_state(proc)


@pytest.mark.asyncio
async def test_starting_process_keeps_its_buffer_across_a_flush():
    proc, path = await _make_process(status=ProcessStatus.STARTING)
    key = str(proc.id)

    await transcript_streamer_registry.notify_change(path)
    await _settle_flushes()

    assert _PENDING_ENTRIES.get(key), "entries buffered before RUNNING stay queued for the next flush"
    ap_module._release_process_transcript_state(proc)


@pytest.mark.asyncio
async def test_headless_exit_releases_state():
    proc, path = await _make_process(shell_id=None, pty_mode=False)
    key = str(proc.id)
    mark_recovered(key)

    await transcript_streamer_registry.notify_change(path)
    await _settle_flushes()
    assert _held(key)["broadcast_key"]

    await proc.exit()
    await _settle_flushes()

    assert _held(key) == NOTHING
    assert (await AgenticProcess.get_by_id(key)).status == ProcessStatus.STOPPED.value
