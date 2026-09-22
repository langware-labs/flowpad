"""A finished Claude turn ends ``stream_transcript`` — including one the API failed.

Claude 2.1.27x writes a ``cost-state`` line after the turn's terminal
``last-prompt``. Unclassified, it was the tail's "last meaningful entry", the
status read UNKNOWN, and no headless Claude turn ever ended the stream: every
caller waited out its timeout (a deployed agent's chat never finished a reply).

A turn the API failed ends on the CLI's synthetic ``API Error`` message — an
ERROR tail. ERROR is an abnormal END (a retry mid-turn is API_ERROR), so once
the worker has exited it ends the stream as COMPLETE does.
"""

import json
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus, _tail_status

SESSION = "18428ba1-af36-43e7-aa80-2e47e00067c6"


def _user(uuid: str) -> dict:
    return {
        "type": "user",
        "uuid": uuid,
        "parentUuid": None,
        "sessionId": SESSION,
        "message": {"role": "user", "content": [{"type": "text", "text": "Say OK"}]},
    }


def _assistant(uuid: str, parent: str, text: str, stop_reason: str, **extra) -> dict:
    return {
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": parent,
        "sessionId": SESSION,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": stop_reason},
        **extra,
    }


def _envelope(leaf: str) -> list[dict]:
    """What the CLI writes after a turn, as measured: a large context attachment
    (~100 KB — it pushes the reply out of the first tail window), the idle marker,
    the latch, then the cost ledger."""
    return [
        {"type": "attachment", "sessionId": SESSION, "attachment": {"type": "context", "content": "x" * 100_000}},
        {"type": "last-prompt", "lastPrompt": "Say OK", "leafUuid": leaf, "sessionId": SESSION},
        {"type": "atis-latch", "atis": "", "sessionId": SESSION},
        {"type": "cost-state", "sessionId": SESSION, "totalCostUSD": 0.05, "modelUsage": {}},
    ]


FINISHED = [_user("u1"), _assistant("a1", "u1", "OK", "end_turn"), *_envelope("a1")]
API_FAILED = [
    _user("u1"),
    _assistant("a1", "u1", "API Error: 500 Internal server error.", "stop_sequence", isApiErrorMessage=True),
    *_envelope("a1"),
]


def _write(path, rows) -> None:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def test_a_trailing_cost_state_does_not_hide_the_turn_end(tmp_path):
    transcript = tmp_path / f"{SESSION}.jsonl"
    _write(transcript, FINISHED)

    assert _tail_status(transcript) == WorkerStatus.COMPLETE


def test_cost_state_is_an_envelope_line_not_an_unknown_entry(tmp_path):
    from flow_sdk.transcript_analyzer import AgentTranscriptFile
    from flow_sdk.transcript_analyzer.entry import EntryKind

    transcript = tmp_path / f"{SESSION}.jsonl"
    _write(transcript, FINISHED)

    kinds = [e.kind for e in AgentTranscriptFile("claude", transcript, session_id=SESSION).entries]
    assert EntryKind.UNKNOWN not in kinds


class _ClaudeTail:
    def __init__(self, path):
        self.path = path

    def transcript_path(self, _process):
        return self.path

    def tail_status(self, path):
        return _tail_status(path)


@pytest.mark.long  # 2.1s: the stream's own 2s settle window
@pytest.mark.timeout(10)
@pytest.mark.parametrize("rows", [FINISHED, API_FAILED], ids=["finished", "api-failed"])
async def test_a_finished_claude_turn_ends_the_stream(tmp_path, rows):
    transcript = tmp_path / f"{SESSION}.jsonl"
    _write(transcript, rows)
    process = SimpleNamespace(id="proc-claude-turn-end", driver=_ClaudeTail(transcript))

    types = [e.get("type") async for e in AgenticProcess.stream_transcript.__get__(process)(timeout=5, poll_interval=0.05)]

    assert types[-1] == "cost-state"
