"""Unit tests for the ``include_content`` seam on the session extractors.

``extract_claude_session_from_path`` / ``extract_codex_session_from_path`` build
a Record from a transcript JSONL. The searchable ``content`` requires a full
per-file transcript parse (``worker_summary_log``) — the dominant cost. Listing
callers that hit many files per request (worker history) pass
``include_content=False`` to skip that parse: they read only the cheap envelope
(session_id / cwd / version) and never touch ``content``. These tests lock that
contract for BOTH vendors — no mocks, driving the real extractor on real JSONL.

Regression: worker-history was parsing the full transcript of ~170 candidate
files per provider just to throw the content away (7.2s → 2.4s once skipped).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.functions.claude_sessions import extract_claude_session_from_path
from flow_sdk.fs_store.indexer.functions.codex_sessions import extract_codex_session_from_path

_CLAUDE_SID = "11111111-1111-4111-8111-111111111111"
_NEEDLE = "hello world unit test needle"
_CODEX_ROLLOUT = Path(__file__).parent / "resources" / "transcripts" / "codex_rollout.jsonl"


def _write_claude_jsonl(tmp_path: Path) -> Path:
    line = json.dumps({
        "parentUuid": None,
        "isSidechain": False,
        "type": "user",
        "message": {"role": "user", "content": _NEEDLE},
        "uuid": "00000000-0000-4000-8000-0000000000c9",
        "timestamp": "2026-04-26T13:12:32.389Z",
        "cwd": "/repo",
        "sessionId": _CLAUDE_SID,
        "version": "2.1.119",
        "gitBranch": "main",
    })
    p = tmp_path / f"{_CLAUDE_SID}.jsonl"
    p.write_text(line + "\n", encoding="utf-8")
    return p


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_include_content_false_skips_parse_keeps_envelope(tmp_path):
    p = _write_claude_jsonl(tmp_path)
    rec = extract_claude_session_from_path(p, include_content=False)
    # Cheap envelope is still read…
    assert rec.session_id == _CLAUDE_SID
    assert rec.cwd == "/repo"
    # …but the expensive transcript content is NOT rendered.
    assert rec.content == ""


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_claude_include_content_true_renders_searchable_text(tmp_path):
    p = _write_claude_jsonl(tmp_path)
    rec = extract_claude_session_from_path(p, include_content=True)  # default
    assert rec.session_id == _CLAUDE_SID
    assert _NEEDLE in rec.content  # the full parse ran and indexed the message


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_codex_include_content_false_skips_parse_keeps_envelope():
    rec = extract_codex_session_from_path(_CODEX_ROLLOUT, include_content=False)
    assert rec.cwd == "/repo"  # envelope read from session_meta
    assert rec.session_id  # non-empty thread/session id
    assert rec.content == ""  # heavy worker_summary_log parse skipped


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_codex_include_content_true_renders_searchable_text():
    rec = extract_codex_session_from_path(_CODEX_ROLLOUT, include_content=True)
    assert rec.cwd == "/repo"
    assert isinstance(rec.content, str) and len(rec.content) > 0  # parse ran
