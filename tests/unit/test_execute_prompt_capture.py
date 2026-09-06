"""``_last_turn_assistant_text`` — the session turn's reply extraction.

Two properties, and the first one is why this file exists.

**Every vendor, not just claude.** The capture used to hand-parse Claude's
``{"message": {"role": "assistant", "content": [...]}}`` JSONL inline. codex,
copilot and opencode each write a different shape, so the parse found nothing
and returned ``""`` — the worker had run fine, the turn went IDLE, and
``run_session_turn`` wrote NO completion. A live session on any non-claude
harness simply never replied, which read from the outside as "that model does
not work with that harness". It was never the model. The fix reads the
analyzer's normalized ``TranscriptEntry`` model instead, so the vendor's own
parser owns the shape. ``test_every_vendor_yields_its_reply`` is the guard: it
runs the real recorded transcript of all four harnesses through the extractor
and would have caught the original bug — and catches vendor five the day its
parser lands, which a claude-only fake never could.

**Only the latest turn.** A resumed session replays every prior turn, so the
extractor must stop at the prompt that opened this one. ``is_meta`` user entries
(system reminders, tool results fed back mid-turn) are not prompts and must not
end the turn; a line re-emitted under the same id (streaming chunk, then the
finalized snapshot) must count once, last-written winning.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.app.actions.execute_prompt import _last_turn_assistant_text
from flow_sdk.transcript_analyzer import AgentTranscriptFile, TranscriptFormat
from flow_sdk.transcript_analyzer.entries import AssistantMessageEntry, UserMessageEntry

_RESOURCES = Path(__file__).resolve().parent / "resources" / "transcripts"

#: ``(worker, recorded transcript, its format, a phrase the reply must contain)``.
#: Real captures, one per harness FlowPad can spawn — the point is that the
#: extractor is vendor-agnostic, so a claude-shaped fake would prove nothing.
VENDORS = [
    ("claude", "claude_multi_block_message.jsonl", None, "Verdict"),
    ("codex", "codex_stream_events.jsonl", TranscriptFormat.CODEX_STREAM, "helper function"),
    ("copilot", "copilot_stream_stdin_prompt.jsonl", TranscriptFormat.COPILOT_STREAM, "stdin-ok"),
    ("opencode", "opencode_stream_hello.jsonl", TranscriptFormat.OPENCODE_STREAM, "Hello"),
]


def _entry(cls, **kwargs):
    """A typed entry with the envelope fields the analyzer requires."""
    base = {"id": kwargs.pop("id"), "session_id": "s1", "timestamp": "2026-09-06T00:00:00Z", "worker": "claude"}
    return cls(**kwargs, **base)


def _assistant(eid: str, text: str) -> AssistantMessageEntry:
    return _entry(AssistantMessageEntry, id=eid, text=text)


def _user(eid: str, text: str, *, is_meta: bool = False) -> UserMessageEntry:
    return _entry(UserMessageEntry, id=eid, text=text, is_meta=is_meta)


@pytest.mark.parametrize("worker, filename, fmt, expected", VENDORS, ids=[v[0] for v in VENDORS])
def test_every_vendor_yields_its_reply(worker, filename, fmt, expected):
    """The recorded transcript of EVERY harness yields that harness's reply.

    The regression the original defect needed: on codex/copilot/opencode the old
    claude-shaped parse returned "" here, and the session silently never replied.
    """
    path = _RESOURCES / filename
    parsed = AgentTranscriptFile(worker, path, transcript_format=fmt) if fmt else AgentTranscriptFile(worker, path)

    reply = _last_turn_assistant_text(parsed.entries)

    assert reply, f"{worker}: extractor found no assistant text in a real {worker} transcript"
    assert expected in reply, f"{worker}: expected {expected!r} in the reply, got {reply[:200]!r}"


def test_only_the_latest_turn_is_returned():
    """A replayed prior turn must not leak into this turn's reply."""
    entries = [
        _user("u1", "first question"),
        _assistant("a1", "FIRST ANSWER"),
        _user("u2", "second question"),
        _assistant("a2", "SECOND ANSWER"),
    ]

    reply = _last_turn_assistant_text(entries)

    assert reply == "SECOND ANSWER", reply


def test_a_meta_user_entry_does_not_end_the_turn():
    """Tool output fed back mid-turn is not a new prompt, so the assistant text
    on both sides of it belongs to the same reply."""
    entries = [
        _user("u1", "question"),
        _assistant("a1", "thinking about tools"),
        _user("u2", "tool result", is_meta=True),
        _assistant("a2", "final answer"),
    ]

    reply = _last_turn_assistant_text(entries)

    assert reply == "thinking about tools\n\nfinal answer", reply


def test_a_repeated_id_counts_once_with_the_last_write_winning():
    """A streamed chunk and its finalized snapshot share an id — one line, and
    the finalized text is the one that survives."""
    entries = [
        _user("u1", "question"),
        _assistant("msg_x", "partial"),
        _assistant("msg_x", "final answer"),
    ]

    reply = _last_turn_assistant_text(entries)

    assert reply == "final answer", reply


def test_no_entries_is_empty_not_an_error():
    assert _last_turn_assistant_text([]) == ""
