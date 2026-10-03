"""``stream_transcript`` never times out a turn whose worker is still live.

Found by a live session against a Windows host: a prompt that created a venv and
pip-installed a package did all its work, but the install was one long tool call
that wrote nothing to the transcript, the 300s budget ran out mid-call, and the
guest was told the turn failed — its reply was lost. The budget now counts only
from when the worker stops; a silent worker with nobody live still times out.
"""

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import (
    AgenticProcess,
    register_prompt_worker,
    unregister_prompt_worker,
)
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


class _FileDriver:
    """WORKING until the transcript says ``done``; the turn then ends with no settle."""

    transcript_settle_seconds = 0

    def __init__(self, path):
        self.path = path

    def transcript_path(self, _process):
        return self.path

    def tail_status(self, path):
        return WorkerStatus.COMPLETE if "done" in path.read_text() else WorkerStatus.WORKING


def _stream(transcript, process_id):
    process = SimpleNamespace(id=process_id, driver=_FileDriver(transcript))
    return AgenticProcess.stream_transcript.__get__(process)


@pytest.mark.asyncio
async def test_a_live_worker_silent_past_the_timeout_is_not_cut_off(tmp_path):
    transcript = tmp_path / "turn.jsonl"
    transcript.write_text('{"type": "working"}\n')
    worker = object()
    register_prompt_worker("proc-long-tool-call", worker)

    async def finish_after_a_long_silence():
        await asyncio.sleep(0.9)  # three times the stream's timeout, with nothing written
        transcript.write_text('{"type": "working"}\n{"type": "done"}\n')
        unregister_prompt_worker("proc-long-tool-call", worker)

    finisher = asyncio.create_task(finish_after_a_long_silence())
    async for _entry in _stream(transcript, "proc-long-tool-call")(timeout=0.3, poll_interval=0.05):
        pass
    await finisher


@pytest.mark.asyncio
async def test_a_silent_turn_with_no_live_worker_still_times_out(tmp_path):
    transcript = tmp_path / "turn.jsonl"
    transcript.write_text('{"type": "working"}\n')
    with pytest.raises(TimeoutError, match="did not reach idle"):
        async for _entry in _stream(transcript, "proc-nobody-live")(timeout=0.3, poll_interval=0.05):
            pass
