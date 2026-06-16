"""Shared fixtures for unit tests that resolve Claude session transcripts."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_store.indexer.functions import claude_sessions as _claude_sessions

CLAUDE_SID = "11111111-1111-4111-8111-111111111111"


def write_claude_transcript(proj: Path, sid: str = CLAUDE_SID, *, n_lines: int = 1) -> Path:
    """Write a Claude JSONL transcript of ``n_lines`` user messages under ``proj``.

    ``n_lines=1`` is the cheap resolvable-session case; a large count produces a
    realistically-heavy transcript for parse-cost tests.
    """
    lines = [
        json.dumps({
            "parentUuid": None, "isSidechain": False, "type": "user",
            "message": {"role": "user", "content": "hello world " * 40 + f" line {i}"},
            "uuid": f"00000000-0000-4000-8000-{i:012d}",
            "timestamp": "2026-04-26T13:12:32.389Z", "cwd": "/repo",
            "sessionId": sid, "version": "2.1.119", "gitBranch": "main",
        })
        for i in range(n_lines)
    ]
    p = proj / f"{sid}.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


@pytest.fixture
def claude_projects(tmp_path, monkeypatch) -> Path:
    """A tmp ``claude_projects_dir`` (get_instance_settings patched); returns the project dir.

    Pair with :func:`write_claude_transcript` to drop a resolvable session under it.
    """
    proj = tmp_path / "-repo"
    proj.mkdir()
    monkeypatch.setattr(
        _claude_sessions, "get_instance_settings",
        lambda: SimpleNamespace(claude_projects_dir=tmp_path),
    )
    return proj
