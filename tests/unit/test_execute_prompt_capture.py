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

from flow_sdk.app.actions.execute_prompt import (
    _api_retry_notice,
    _last_turn_assistant_text,
    _last_turn_ended_in_error,
    _last_turn_error_text,
)
from flow_sdk.transcript_analyzer import AgentTranscriptFile, TranscriptFormat
from flow_sdk.transcript_analyzer.entries import AssistantMessageEntry, SystemEntry, UserMessageEntry

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


def _error(eid: str, message: str) -> SystemEntry:
    return _entry(SystemEntry, id=eid, subtype="error", payload={"message": message})


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


# ── _last_turn_error_text — the sentence "the agent ended error" otherwise throws away ──


def test_last_turn_error_text_reads_the_systementrys_own_message():
    """deepagents and opencode emit their own failures as
    ``SystemEntry(subtype="error", payload={"message": ...})`` — the exact shape a rate-limit
    or a chain-rejected model surfaces as. This is the one sentence that turns "the agent
    ended error" into something a person can act on."""
    entries = [
        _user("u1", "install ripgrep"),
        _error("e1", "OpenAIRateLimitError: limit 'cost_usd_total' exceeded on endpoint Alice 72"),
    ]

    assert (
        _last_turn_error_text(entries) == "OpenAIRateLimitError: limit 'cost_usd_total' exceeded on endpoint Alice 72"
    )


def test_last_turn_error_text_only_the_latest_turn():
    """A replayed prior turn's error must not leak into this turn's — same rule as
    ``_last_turn_assistant_text``."""
    entries = [
        _user("u1", "first question"),
        _error("e1", "stale error from an earlier turn"),
        _user("u2", "second question"),
        _assistant("a2", "this one actually finished"),
    ]

    assert _last_turn_error_text(entries) == ""


def test_last_turn_error_text_empty_when_the_turn_has_no_error():
    entries = [_user("u1", "question"), _assistant("a1", "all good")]

    assert _last_turn_error_text(entries) == ""


def test_last_turn_error_text_no_entries_is_empty_not_an_error():
    assert _last_turn_error_text([]) == ""


# ── a provider's refusal is the turn's error, never its reply ──


def _claude_turn(api_error_row: dict) -> list:
    from flow_sdk.transcript_analyzer.parsers.claude import ClaudeParser  # noqa: PLC0415

    parser = ClaudeParser("s1")
    user_row = {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "run the tests"}}
    return parser.feed(user_row, 0) + parser.feed(api_error_row, 1)


@pytest.mark.parametrize(
    ("row", "reason"),
    [
        (
            {
                "type": "assistant",
                "uuid": "a1",
                "isApiErrorMessage": True,
                "apiErrorStatus": 429,
                "error": "rate_limit",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "API Error: 429 out of credits"}],
                },
            },
            "API Error: 429 out of credits",
        ),
        (
            {
                "type": "assistant",
                "uuid": "a1",
                "isApiErrorMessage": True,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Credit balance is too low"}]},
            },
            "Credit balance is too low",
        ),
    ],
)
def test_a_claude_api_error_is_the_turns_error_not_its_reply(row, reason):
    entries = _claude_turn(row)

    assert _last_turn_assistant_text(entries) == ""
    assert _last_turn_error_text(entries) == reason


def test_a_turn_cut_off_by_the_provider_ended_in_its_error_despite_the_narration():
    """The real 429 shape: a few "Let me check…" lines, then the refusal. The
    narration is not an answer — the turn ended on the error."""
    entries = [
        _user("u1", "diagnose flowpad"),
        _assistant("a1", "Let me check the logs:"),
        _entry(AssistantMessageEntry, id="a2", text="API Error: Request rejected (429)", is_api_error=True),
    ]

    assert _last_turn_assistant_text(entries) == "Let me check the logs:"
    assert _last_turn_ended_in_error(entries) == "API Error: Request rejected (429)"


def test_an_error_the_agent_recovered_from_is_not_how_the_turn_ended():
    entries = [_user("u1", "q"), _error("e1", "transient"), _assistant("a1", "here is the answer")]

    assert _last_turn_ended_in_error(entries) == ""


# ── _api_retry_notice — the reason, at the FIRST retry rather than after the last ──

#: A real Claude 2.1.302 retry line for a 429 (credits exhausted).
_RETRY_LINE = {
    "type": "system",
    "subtype": "api_error",
    "level": "error",
    "error": {
        "message": '429 {"type":"error","error":{"type":"rate_limit_error","message":"Your credit balance is too low"}}'
    },
    "retryInMs": 1000,
    "retryAttempt": 1,
    "maxRetries": 10,
    "timestamp": "2026-10-18T16:54:50.163Z",
}


def test_a_retry_line_names_the_providers_reason_and_the_attempt():
    assert _api_retry_notice(_RETRY_LINE, since="2026-10-18T16:54:00.000Z") == (
        "API Error 429 · Your credit balance is too low — retrying (attempt 1 of 10)"
    )


def test_a_retry_line_from_an_earlier_turn_is_not_this_turns():
    assert _api_retry_notice(_RETRY_LINE, since="2026-10-18T17:00:00.000Z") == ""


def test_an_unparsed_error_body_is_kept_whole():
    line = {**_RETRY_LINE, "error": {"message": "socket hang up"}}
    assert _api_retry_notice(line, since="").startswith("API Error · socket hang up — retrying")


def test_other_lines_are_no_retry():
    assert _api_retry_notice({"type": "assistant", "timestamp": "2026-10-18T16:54:50.163Z"}, since="") == ""
