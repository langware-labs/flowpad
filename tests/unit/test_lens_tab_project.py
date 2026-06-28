"""Captures the second half of this session's RCA: the lens TAB stays
projectless ('blue') for an unindexed claude session.

The backend entity recovery (test_lens_project_recovery) makes
``ClaudeSession.get_by_id`` resolve ``project_id`` for an unindexed on-disk
session, so the active-project CONTEXT heals. But the persisted Tab row's
``project_id`` is still null → the chip renders project-less (blue). Why:
``ensure_tab`` trusts the CLIENT-supplied ``project_id``, which is null on a
cold/bare open (``getFromDockPointer`` reads the target cache-first and misses),
and nothing re-derives it server-side. The fix: ``ensure_tab`` resolves the
tab's project from the TARGET entity server-side when the client didn't supply
one (where the on-disk recovery applies).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

# Importing the entity registers the type (Entity.__init_subclass__).
from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: F401
from flow_sdk.builtin.tab import ensure_tab
from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd

CLAUDE_SID = "7313667f-ab48-4add-8918-e6b30b8f8a77"


@pytest.mark.asyncio
async def test_lens_tab_gets_project_from_unindexed_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Real cwd + an on-disk transcript for the session — NOT indexed (no DB row).
    cwd = tmp_path / "workdir"
    cwd.mkdir()
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

    expected = resolve_project_id_for_cwd(str(cwd))
    assert expected, "precondition: cwd resolves to a project id"

    # The client opens the lens tab with NO usable project (cache-miss → null),
    # exactly as getFromDockPointer does on a cold/bare load of an unindexed
    # session lens.
    pointer = json.dumps({"viewType": "lens", "pointer": f"claude/transcript/{CLAUDE_SID}"})
    tab = await ensure_tab(
        pointer,
        target_type="claude_session",
        target_id=CLAUDE_SID,
        project_id=None,
    )

    assert tab.project_id == expected, (
        f"lens tab is projectless (project_id={tab.project_id!r}) — the chip stays "
        f"blue even though the target session resolves project {expected!r}"
    )
