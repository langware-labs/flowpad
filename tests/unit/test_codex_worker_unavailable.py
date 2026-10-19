"""Codex provider-limit failures normalize to ``WorkerUnavailableEntry``.

``codex exec --json`` reports an exhausted account as a bare ``error`` line
followed by ``turn.failed``. Both used to fall through to ``UnknownEntry``
(warning-only), which made "the account is out of credits" indistinguishable
from "the turn produced no answer" for every transcript consumer.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.cli_drivers.codex.event_to_flowdata import (
    convert_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.transcript_analyzer.entry import EntryKind
from flow_sdk.transcript_analyzer.parsers.codex import CodexParser

_USAGE_LIMIT = (
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
    "to purchase more credits or try again at Aug 9th, 2026 5:30 PM."
)


def _stream(*events: dict) -> list:
    parser = CodexParser()
    out = []
    for index, event in enumerate(events):
        out.extend(parser.feed(event, index))
    return out


def test_usage_limit_error_becomes_worker_unavailable():
    entries = _stream(
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "turn.started"},
        {"type": "error", "message": _USAGE_LIMIT},
    )
    unavailable = [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
    assert len(unavailable) == 1
    entry = unavailable[0]
    assert entry.reason == "quota_exhausted"
    assert entry.worker_type == "codex"
    assert _USAGE_LIMIT in entry.message


def test_turn_failed_carries_the_nested_message():
    entries = _stream(
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "turn.failed", "error": {"message": _USAGE_LIMIT}},
    )
    unavailable = [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
    assert len(unavailable) == 1
    assert unavailable[0].reason == "quota_exhausted"


def test_non_limit_error_stays_a_plain_system_row():
    """A real crash must NOT be reclassified as an account problem."""
    entries = _stream(
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "error", "message": "stream disconnected before completion"},
    )
    assert not [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
    assert entries[-1].kind is EntryKind.SYSTEM


def test_rollout_event_msg_error_is_normalized_too():
    entries = _stream(
        {"type": "session_meta", "payload": {"id": "s1"}},
        {"type": "event_msg", "payload": {"type": "error", "message": _USAGE_LIMIT}},
    )
    unavailable = [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
    assert len(unavailable) == 1
    assert unavailable[0].reason == "quota_exhausted"


def test_live_stream_frame_is_worker_unavailable_not_a_raw_error():
    frames = convert_event({"type": "error", "message": _USAGE_LIMIT})
    assert [f.attributes.get("element-type") for f in frames] == [
        FlowElementType.WORKER_UNAVAILABLE
    ]
    assert frames[0].attributes.get("reason") == "quota_exhausted"


def test_live_stream_keeps_raw_error_for_a_real_crash():
    frames = convert_event({"type": "error", "message": "segfault"})
    assert [f.attributes.get("element-type") for f in frames] == [
        FlowElementType.ERROR
    ]


def test_rollout_task_complete_error_is_normalized():
    """Codex reports a mid-turn quota stop on ``task_complete``, not ``error``."""
    entries = _stream(
        {"type": "session_meta", "payload": {"id": "s1"}},
        {
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "last_agent_message": None,
                "error": {"message": _USAGE_LIMIT},
            },
        },
    )
    unavailable = [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
    assert len(unavailable) == 1
    assert unavailable[0].reason == "quota_exhausted"


def test_a_user_turn_about_rate_limits_is_not_reclassified():
    entries = _stream(
        {"type": "session_meta", "payload": {"id": "s1"}},
        {
            "type": "event_msg",
            "payload": {"type": "task_complete", "last_agent_message": "usage limit"},
        },
    )
    assert not [e for e in entries if e.kind is EntryKind.WORKER_UNAVAILABLE]
