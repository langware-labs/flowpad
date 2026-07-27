"""Captures the RCA from this session: an on-disk but UNINDEXED Claude session
must still resolve its owning project in the BACKEND.

Symptom (browser): /dock/lens/claude/transcript/<id> doesn't heal the tab's
project_id. RCA: the frontend lens loader bails when ClaudeSession.get_by_id is
null, and `claude_session/7313667f…` IS null — it's the live, never-indexed
session. Yet its transcript is on disk under ~/.claude/projects/<cwd-encoded>/,
and sibling INDEXED sessions in the SAME folder carry project_id (they heal).
The proven lever is the indexed entity. The fix belongs server-side: the backend
should recover the project from the transcript's cwd even when the entity was
never indexed — so `ClaudeSession.get_by_id` returns it, exactly the call the
lens loader (and Tab mint) already make.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd
from flow_sdk.fs_store.path_utils import is_valid_project_cwd

# The active session id from the RCA (never indexed → "Entity not found").
CLAUDE_SID = "7313667f-ab48-4add-8918-e6b30b8f8a77"


@pytest.mark.asyncio
async def test_unindexed_claude_session_recovers_project_from_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A real cwd so canonicalization (Path.resolve) succeeds — this is the
    # working dir the transcript was recorded in, the one the folder encodes.
    cwd = tmp_path / "workdir"
    cwd.mkdir()
    assert is_valid_project_cwd(cwd, include_temp=True), (
        "fixture premise: the lens transcript must belong to a real project, "
        "not HOME/an infrastructure root"
    )

    # An on-disk Claude transcript for the session — but NOT indexed (no DB row,
    # exactly like the live session). resolve_session_jsonl globs
    # ~/.claude/projects/*/<id>.jsonl; point that at our tmp root.
    projects_root = tmp_path / ".claude" / "projects"
    proj_dir = projects_root / "-encoded-workdir"
    proj_dir.mkdir(parents=True)
    (proj_dir / f"{CLAUDE_SID}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(cwd), "sessionId": CLAUDE_SID}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "flow_sdk.transcript_analyzer.resolver._claude_projects_dir",
        lambda: projects_root,
    )

    # The owning project the backend should heal to (no real Project row → the
    # deterministic path-derived alias; the SAME primitive the indexer stamps on
    # cwd-bearing records, so the recovered tab and a later re-index never diverge).
    expected_project_id = resolve_project_id_for_cwd(str(cwd))
    assert expected_project_id, "precondition: cwd resolves to a project id"

    # The bug: the session was never indexed, so the backend can't map it to a
    # project — get_by_id returns None and the lens loader bails. The recovery
    # should materialize it from its on-disk transcript's cwd.
    session = await ClaudeSession.get_by_id(CLAUDE_SID)
    assert session is not None, (
        "unindexed on-disk Claude session was not recovered by the backend "
        "(get_by_id returned None) — the lens/tab project_id can never heal"
    )
    assert session.project_id == expected_project_id, (
        f"recovered session project_id {session.project_id!r} != "
        f"cwd-resolved {expected_project_id!r}"
    )
