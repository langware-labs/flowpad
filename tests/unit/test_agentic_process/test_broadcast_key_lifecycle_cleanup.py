"""The process-scoped values are released when the process goes down.

``_last_broadcast_key`` is backed by the module-level ``_LAST_BROADCAST_KEYS``
dict (keyed by process id) precisely so it survives the fresh AP instance the
transcript watcher hydrates per streamer event. That lifetime is the point of
the design — and the reason nothing implicit ever frees it: the instance dying
no longer drops the row. ``close()`` and ``delete()`` are the two lifecycle
exits, so each must drop it explicitly, or the dict grows for the lifetime of
the server and a re-opened process starts out deduping against the key it last
broadcast before it went down.

The turn-end reindex watermark (``_REINDEX_WATERMARKS``) is the same shape for
the same reason, so it is pinned on the same exits here rather than in a
parallel file.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import _LAST_BROADCAST_KEYS, _REINDEX_WATERMARKS
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def _make_ap() -> AgenticProcess:
    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id="00000000-0000-0000-0000-000000000001",
        worker_type=WorkerType.CLAUDE_CODE,
    )
    ap.status = ProcessStatus.RUNNING.value
    await ap.save(notify=False)
    ap._last_broadcast_key = ("running", True, "thinking")
    _REINDEX_WATERMARKS[str(ap.id)] = 42
    assert str(ap.id) in _LAST_BROADCAST_KEYS
    assert str(ap.id) in _REINDEX_WATERMARKS
    return ap


@pytest.mark.asyncio
async def test_close_releases_broadcast_key(initialize_test_db) -> None:
    ap = await _make_ap()

    assert await ap.close() is True

    assert str(ap.id) not in _LAST_BROADCAST_KEYS
    assert ap._last_broadcast_key is None
    assert str(ap.id) not in _REINDEX_WATERMARKS


@pytest.mark.asyncio
async def test_close_releases_broadcast_key_even_when_teardown_fails(initialize_test_db, monkeypatch) -> None:
    """The clear lives in a ``finally`` — a failed close leaks nothing either."""
    ap = await _make_ap()

    original_save = type(ap).save
    calls: list[None] = []

    async def _boom_once(self, *a, **kw):
        # Only the first save fails: the except arm saves the FAILED status and
        # must be allowed to complete, otherwise close() raises instead of
        # returning False and the test would prove nothing about the arm.
        calls.append(None)
        if len(calls) == 1:
            raise RuntimeError("save exploded")
        return await original_save(self, *a, **kw)

    monkeypatch.setattr(type(ap), "save", _boom_once, raising=False)

    assert await ap.close() is False

    assert str(ap.id) not in _LAST_BROADCAST_KEYS
    assert str(ap.id) not in _REINDEX_WATERMARKS


@pytest.mark.asyncio
async def test_delete_releases_broadcast_key(initialize_test_db) -> None:
    ap = await _make_ap()

    await ap.delete()

    assert str(ap.id) not in _LAST_BROADCAST_KEYS
    assert ap._last_broadcast_key is None
    assert str(ap.id) not in _REINDEX_WATERMARKS


# A transport flip starts a new broadcast history. The key only records what the
# transcript FLUSH last broadcast; a headless turn's end edge goes out on the
# prompt path, so the key can still read the old turn's ``busy=True`` triple. A
# native-xterm turn's busy edges come from the flush alone, so a stale key made
# the first PTY turn a "duplicate": the UI never saw ``busy=True``, its transport
# gate passed on a stale idle, and the switch back to chat 409'd with nothing to
# retry it (ui/tests/long_tests/vibe_return_from_terminal_reconcile.test.tsx).


class _StopAfterFlip(Exception):
    pass


@pytest.mark.asyncio
async def test_headless_to_pty_flip_forgets_broadcast_key(initialize_test_db, monkeypatch) -> None:
    ap = await _make_ap()
    ap.pty_mode = False
    ap.shell_id = str(uuid.uuid4())
    await ap.save(notify=False)
    ap._last_broadcast_key = ("running", True, "working")

    async def _stop(self, *a, **kw):
        raise _StopAfterFlip

    # ``shell()`` is the first await after the flip — stop there, no PTY spawned.
    # The launch runs on a re-read row, so the flip is observed through the
    # process-scoped key (and the row it would have saved), not ``ap``.
    monkeypatch.setattr(AgenticProcess, "shell", _stop)
    # The open's own failure handling swallows the stop into an ApiFailResponse.
    await ap.start_pty(visible=True, retry=True)

    assert ap._last_broadcast_key is None


@pytest.mark.asyncio
async def test_pty_to_headless_flip_forgets_broadcast_key(initialize_test_db) -> None:
    ap = await _make_ap()
    ap.pty_mode = True
    await ap.save(notify=False)
    ap._last_broadcast_key = ("running", True, "working")

    result = await ap._enter_cli_mode()

    assert getattr(result, "status", None) != "FAIL"
    assert ap._last_broadcast_key is None
