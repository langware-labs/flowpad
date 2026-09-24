"""``stream_transcript`` ends a copilot PTY turn on its IDLE ``assistant.turn_end``.

Copilot's interactive session record has no terminal marker: a finished turn
ends on ``assistant.turn_end`` (IDLE) with the PTY waiting at its prompt. The
stream only exited on COMPLETE/INTERRUPTED/INACTIVE, so a turn that finished in
~70s held the caller until copilot shut down at its timeout.

IDLE ends the turn only for a driver that recognises user turns — Claude's bare
``system:init`` is IDLE too — and only once a user turn has landed since the
stream opened: a reused session's tail is the PRIOR turn's IDLE, and settling on
it returned before the second prompt was typed (markdown_index incremental).

"Since" is counted from the PROMPT, not from the stream's first read: Copilot
1.0.88 creates its session record only together with the first ``user.message``,
so the file as first read already held this turn and a fresh PTY turn never
ended (markdown_index cold build, 240s cap, 2026-09-23).
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus


def _rows(*rows):
    return "".join(json.dumps(r) + "\n" for r in rows)


FINISHED_TURN = (
    {"type": "user.message", "data": {"content": "rebuild"}},
    {"type": "assistant.turn_start", "data": {"turnId": "0"}},
    {"type": "assistant.message", "data": {"content": "done"}},
    {"type": "assistant.turn_end", "data": {"turnId": "0"}},
    {"type": "session.usage_checkpoint", "data": {}},
)


class _IdleOnlyDriver:
    """A tail that reads IDLE from a driver that does not recognise user turns."""

    def __init__(self, path):
        self.path = path

    def transcript_path(self, _process):
        return self.path

    def tail_status(self, _path):
        return WorkerStatus.IDLE


def _stream(driver, process_id):
    return AgenticProcess.stream_transcript.__get__(SimpleNamespace(id=process_id, driver=driver))


def _copilot_driver(monkeypatch, transcript):
    driver = CopilotDriver()
    monkeypatch.setattr(driver, "transcript_path", lambda _p: transcript)
    return driver


async def _assert_the_stream_does_not_end(stream):
    with pytest.raises(TimeoutError, match="did not reach idle"):
        async for _entry in stream(timeout=0.5, poll_interval=0.05):
            pass


@pytest.mark.long  # 2.3s: the stream's own 2s settle window
@pytest.mark.timeout(10)
async def test_copilot_idle_after_a_new_user_turn_ends_the_stream(tmp_path, monkeypatch):
    transcript = tmp_path / "events.jsonl"
    transcript.write_text(_rows({"type": "session.start", "data": {}}), encoding="utf-8")

    async def _turn_lands():
        await asyncio.sleep(0.2)
        with open(transcript, "a", encoding="utf-8") as fh:
            fh.write(_rows(*FINISHED_TURN))

    landing = asyncio.create_task(_turn_lands())
    stream = _stream(_copilot_driver(monkeypatch, transcript), "proc-copilot-idle")
    types = [entry.get("type") async for entry in stream(timeout=6, poll_interval=0.05)]
    await landing

    assert types[-2:] == ["assistant.turn_end", "session.usage_checkpoint"]


@pytest.mark.timeout(5)
async def test_a_prior_turns_idle_at_open_does_not_end_the_stream(tmp_path, monkeypatch):
    """A reused session: the tail is the previous turn's end, then a resume."""
    transcript = tmp_path / "events.jsonl"
    transcript.write_text(
        _rows({"type": "session.start", "data": {}}, *FINISHED_TURN, {"type": "session.resume", "data": {}}),
        encoding="utf-8",
    )

    await _assert_the_stream_does_not_end(_stream(_copilot_driver(monkeypatch, transcript), "proc-copilot-reused"))


@pytest.mark.timeout(5)
async def test_idle_does_not_end_the_stream_for_a_driver_without_user_turns(tmp_path):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({"type": "system", "subtype": "init"}) + "\n", encoding="utf-8")

    await _assert_the_stream_does_not_end(_stream(_IdleOnlyDriver(transcript), "proc-claude-init"))


def _prompted(driver, process_id):
    """Take the prompt-time baseline the way ``prompt()`` does, then stream."""
    process = SimpleNamespace(id=process_id, driver=driver)
    AgenticProcess._note_transcript_size_at_prompt(process)
    return AgenticProcess.stream_transcript.__get__(process)


@pytest.mark.long  # 2.3s: the stream's own 2s settle window
@pytest.mark.timeout(10)
async def test_a_session_record_born_with_its_first_turn_ends_the_stream(tmp_path, monkeypatch):
    """Copilot 1.0.88: no file at prompt time; it first appears holding the user turn."""
    transcript = tmp_path / "events.jsonl"
    stream = _prompted(_copilot_driver(monkeypatch, transcript), "proc-copilot-lazy-record")
    transcript.write_text(_rows({"type": "session.start", "data": {}}, *FINISHED_TURN), encoding="utf-8")

    types = [entry.get("type") async for entry in stream(timeout=6, poll_interval=0.05)]

    assert types[-2:] == ["assistant.turn_end", "session.usage_checkpoint"]


@pytest.mark.timeout(5)
async def test_a_prior_turns_idle_does_not_end_a_prompted_stream(tmp_path, monkeypatch):
    """The prompt-time baseline still holds the reused session's earlier turn."""
    transcript = tmp_path / "events.jsonl"
    transcript.write_text(
        _rows({"type": "session.start", "data": {}}, *FINISHED_TURN, {"type": "session.resume", "data": {}}),
        encoding="utf-8",
    )

    await _assert_the_stream_does_not_end(_prompted(_copilot_driver(monkeypatch, transcript), "proc-copilot-reprompt"))
