"""Which transcript row ends a PTY turn is a VENDOR fact, not a ladder.

``_pty_turn_complete`` used to branch on ``worker_type == "claude"`` /
``"copilot"`` / ``!= "codex"`` inside ``AgenticProcess`` — the densest vendor
leak in a file whose own docstring calls itself vendor-pure. Each driver now
declares :meth:`pty_turn_complete`, read through ``getattr`` exactly like
``is_transcript_user_turn``, so a vendor that omits it simply never completes
on a marker and falls back to inactivity.

The generic gates (SYSTEM row, not a sidechain, user row landed) stay on the
process — they are true for every vendor.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.transcript_analyzer.entry import EntryKind


def _entry(subtype: str, *, payload=None, kind=EntryKind.SYSTEM, sidechain=False):
    return SimpleNamespace(kind=kind, subtype=subtype, payload=payload, is_sidechain=sidechain)


def _complete(worker_type: str, entry, *, active_turn_id=None, landed=True) -> bool:
    return AgenticProcess._pty_turn_complete(
        entry, worker_type=worker_type, active_turn_id=active_turn_id, user_turn_landed=landed
    )


# ── each vendor's own marker ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("worker_type", "marker"),
    [("claude", "turn_duration"), ("copilot", "assistant.turn_end")],
)
def test_the_vendors_marker_ends_its_turn(worker_type, marker):
    assert _complete(worker_type, _entry(marker)) is True


@pytest.mark.parametrize(
    ("worker_type", "foreign"),
    [("claude", "assistant.turn_end"), ("copilot", "turn_duration")],
)
def test_another_vendors_marker_does_not(worker_type, foreign):
    """The ladder made this easy to get wrong; the trait makes it structural."""
    assert _complete(worker_type, _entry(foreign)) is False


def test_opencode_omits_the_trait_and_never_completes_on_a_marker():
    """It has no terminal row — inactivity is its only end condition."""
    for subtype in ("turn_duration", "assistant.turn_end", "event_msg.task_complete"):
        assert _complete("opencode", _entry(subtype)) is False


# ── codex turn-id correlation ───────────────────────────────────────────────


def test_codex_bare_task_complete_ends_the_active_turn():
    """Codex often omits turn_id; waiting out inactivity would be wrong."""
    assert _complete("codex", _entry("event_msg.task_complete"), active_turn_id="t-1") is True


def test_codex_matching_turn_id_ends_it():
    entry = _entry("event_msg.task_complete", payload={"turn_id": "t-1"})
    assert _complete("codex", entry, active_turn_id="t-1") is True


def test_codex_mismatched_turn_id_belongs_to_another_turn():
    entry = _entry("event_msg.task_complete", payload={"turn_id": "t-OTHER"})
    assert _complete("codex", entry, active_turn_id="t-1") is False


# ── the generic gates stay on the process ───────────────────────────────────


def test_a_marker_before_the_user_row_landed_is_ignored():
    assert _complete("claude", _entry("turn_duration"), landed=False) is False


def test_a_sidechain_marker_is_ignored():
    assert _complete("claude", _entry("turn_duration", sidechain=True)) is False


def test_a_non_system_row_is_ignored():
    assert _complete("claude", _entry("turn_duration", kind=EntryKind.ASSISTANT_MESSAGE)) is False
