"""Session-id transcript resolution is LOCAL-ONLY.

``resolve_session_jsonl`` answers one question: "which transcript did THIS
machine record for this session id?" It searches the worker's own CLI dir and
nothing else.

It used to fall back to a dedicated received-transcripts store so that a shared
session's by-id chip would open on the receiver. That store is gone: a received
transcript is now an ordinary file-backed asset, installed wherever the user
chose and addressed by its ``asset_ref`` path. Removing the fallback also closes
a real hole — when two users' transcripts sit under one home dir (two instances
on one machine), an id-keyed search would hand the receiver the *sender's* file
and make their live session look resumable.

Worker-generic: claude / codex / copilot behave identically.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer.resolver import (
    SESSION_TYPE_BY_WORKER,
    TranscriptNotFoundError,
    resolve_session_jsonl,
)


@pytest.fixture()
def isolated_instance(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


def test_sender_resolves_local_cli_transcript(isolated_instance):
    """The machine that ran the session resolves it from the local CLI dir.

    The resolver reads the *instance-configured* Claude projects dir
    (``get_instance_settings().claude_projects_dir``), never a hardcoded
    ``~/.claude`` — so the transcript must be placed where the resolver actually
    looks, not at a hand-built HOME-derived path."""
    sid = str(uuid.uuid4())
    proj = isolated_instance.claude_projects_dir / "encoded-proj"
    proj.mkdir(parents=True, exist_ok=True)
    local = proj / f"{sid}.jsonl"
    local.write_text(f'{{"sessionId":"{sid}","origin":"local"}}\n', encoding="utf-8")

    assert resolve_session_jsonl("claude", sid) == local


@pytest.mark.parametrize("worker", ["claude", "codex", "copilot"])
def test_foreign_session_does_not_resolve(isolated_instance, worker):
    """A session this machine never ran is a miss — never a silent match.

    This is the anti-regression for the shared-home incident: a receiver asking
    for a sender's session id must NOT be handed a transcript. It has no local
    run, and its received copy is reached by path, not by id."""
    sid = str(uuid.uuid4())
    with pytest.raises(TranscriptNotFoundError):
        resolve_session_jsonl(worker, sid)


def test_session_type_by_worker_covers_every_session_worker():
    """The one worker → session-entity-type map. Anything needing that direction
    reads it here rather than re-listing the three types (``workflow`` has no
    session entity — its journals are run artifacts)."""
    assert SESSION_TYPE_BY_WORKER == {
        "claude": "claude_session",
        "codex": "codex_session",
        "copilot": "copilot_session",
    }
