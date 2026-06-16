"""Regression: ``_capture_assistant_reply`` must return ONLY the latest turn.

Bug (this session): ``stream_transcript`` replays the whole JSONL from the top,
and a resumed Claude session re-emits every prior turn. The old capture used a
fixed line offset to skip prior turns; the offset misaligned with the replayed
stream, so every earlier assistant reply leaked into each new conversation
message. The switch is the turn-boundary slicing in ``_capture_assistant_reply``
(reset the collected text on each genuine user prompt).

This test feeds a faithful two-turn replay and asserts the captured reply is the
SECOND turn's answer only — not the first turn's, and not a tool_result-induced
split. It fails (returns both answers) against the old offset-based logic and
passes against the turn-boundary logic.
"""
from __future__ import annotations

from flow_sdk.app.actions.execute_prompt import _capture_assistant_reply


def _user(content):
    return {"type": "user", "message": {"role": "user", "content": content}}


def _assistant(mid, text):
    return {
        "type": "assistant",
        "message": {
            "id": mid,
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


class _FakeProcess:
    """Minimal stand-in: ``_capture_assistant_reply`` only calls
    ``stream_transcript``. We replay a multi-turn transcript exactly as
    ``AgenticProcess.stream_transcript`` would on a resumed session (whole file
    from the top, one parsed dict per line)."""

    def __init__(self, entries):
        self._entries = entries

    async def stream_transcript(self, timeout=300, poll_interval=0.2):
        for entry in self._entries:
            yield entry


async def test_capture_returns_only_latest_turn():
    entries = [
        # ── Turn 1 (already shown in a prior message) ──
        _user("first question"),
        _assistant("msg_1", "FIRST ANSWER"),
        # ── Turn 2 (the one this capture is for) ──
        _user("second question"),
        # mid-turn tool round-trip: a tool_result user entry must NOT be
        # treated as a new turn boundary (it's tool output fed back to Claude).
        _assistant("msg_2a", "thinking about tools"),
        _user([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        _assistant("msg_2b", "SECOND ANSWER"),
    ]
    ap = _FakeProcess(entries)

    reply = await _capture_assistant_reply(ap)

    # The bug: prior-turn text leaks in.
    assert "FIRST ANSWER" not in reply, f"prior turn leaked into reply: {reply!r}"
    # The tool round-trip is mid-turn, so its assistant text belongs to turn 2.
    assert reply == "thinking about tools\n\nSECOND ANSWER", reply


async def test_repeated_snapshot_does_not_duplicate():
    """Claude writes some assistant messages twice (streaming + finalized
    snapshot share ``message.id``); the finalized text must win once, not
    duplicate."""
    entries = [
        _user("question"),
        _assistant("msg_X", "partial"),        # streaming snapshot
        _assistant("msg_X", "final answer"),   # finalized snapshot, same id
    ]
    reply = await _capture_assistant_reply(_FakeProcess(entries))
    assert reply == "final answer", reply
