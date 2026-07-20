"""Cross-machine transcript resolution.

A session shared from another machine never ran locally, so the worker CLI
dirs (``~/.claude/projects`` …) have nothing. The transcript rides in with the
share as a FILE attachment; ``_materialize_received_transcripts`` persists it to
the instance's received-transcripts store, and ``resolve_session_jsonl`` falls
back to that store — so the by-session-id transcript chip opens on the receiver.

Worker-generic: claude / codex / copilot all flow through the same store.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.flow_message_bundle import _materialize_received_transcripts
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    received_transcript_dest,
    resolve_session_jsonl,
)


@pytest.fixture()
def isolated_instance(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox"))
    reset_instance_settings()
    yield get_instance_settings()
    reset_instance_settings()


@pytest.mark.parametrize("worker", ["claude", "codex", "copilot"])
def test_resolver_falls_back_to_received_store(isolated_instance, worker):
    """A transcript present only in the received store resolves by session id."""
    sid = str(uuid.uuid4())
    # Not in any local CLI dir → would normally be a miss.
    with pytest.raises(TranscriptNotFoundError):
        resolve_session_jsonl(worker, sid)

    dest = received_transcript_dest(worker, sid)
    assert dest is not None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(f'{{"sessionId":"{sid}"}}\n', encoding="utf-8")

    assert resolve_session_jsonl(worker, sid) == dest


def test_sender_resolves_local_cli_transcript(isolated_instance):
    """Sender side: the machine that ran the session resolves it from the local
    CLI dir (the path tried first) and prefers it over the received store — the
    fallback must not shadow a real local run."""
    sid = str(uuid.uuid4())
    proj = isolated_instance.claude_projects_dir / "encoded-proj"
    proj.mkdir(parents=True, exist_ok=True)
    local = proj / f"{sid}.jsonl"
    local.write_text(f'{{"sessionId":"{sid}","origin":"local"}}\n', encoding="utf-8")

    # A received-store copy also exists; local must still win.
    received = received_transcript_dest("claude", sid)
    assert received is not None
    received.parent.mkdir(parents=True, exist_ok=True)
    received.write_text(f'{{"sessionId":"{sid}","origin":"received"}}\n', encoding="utf-8")

    assert resolve_session_jsonl("claude", sid) == local


@pytest.mark.parametrize(
    "session_type,worker",
    [("claude_session", "claude"), ("codex_session", "codex"), ("copilot_session", "copilot")],
)
def test_unpack_materializes_carried_transcript(isolated_instance, tmp_path, session_type, worker):
    """A worker-session chip + its transcript FILE attachment → received store."""
    sid = str(uuid.uuid4())
    files_dir = tmp_path / "attachment" / "files"
    files_dir.mkdir(parents=True)
    transcript = files_dir / "conversation.jsonl"
    transcript.write_text(
        f'{{"type":"custom-title","sessionId":"{sid}"}}\n'
        f'{{"type":"user","message":{{"role":"user","content":"hi"}},"sessionId":"{sid}"}}\n',
        encoding="utf-8",
    )

    fm_data = {
        "attachment": [
            {"attachment_type": "type_id", "data": f"{session_type}-{sid}"},
            {"attachment_type": "file", "data": "attachment/files/conversation.jsonl"},
        ]
    }

    _materialize_received_transcripts(fm_data, tmp_path)

    resolved = resolve_session_jsonl(worker, sid)
    assert resolved == received_transcript_dest(worker, sid)
    assert sid in resolved.read_text(encoding="utf-8")


def test_unpack_noop_without_session_attachment(isolated_instance, tmp_path):
    """A plain FILE attachment with no worker session is left alone."""
    sid = str(uuid.uuid4())
    files_dir = tmp_path / "attachment" / "files"
    files_dir.mkdir(parents=True)
    (files_dir / "notes.txt").write_text(f"just a file mentioning {sid}", encoding="utf-8")

    fm_data = {"attachment": [{"attachment_type": "file", "data": "attachment/files/notes.txt"}]}
    # No raise, and no transcript materialized (no worker-session chip).
    _materialize_received_transcripts(fm_data, tmp_path)

    dest = received_transcript_dest("claude", sid)
    assert dest is not None and not dest.exists()
