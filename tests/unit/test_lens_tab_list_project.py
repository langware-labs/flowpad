"""Captures the REAL navigation path of the 'blue tab' bug.

The chip is rendered from the backend-owned tab LIST (``list_all`` /
``_serialize_row``), and the FE does NOT re-mint an existing tab on reopen — so a
tab row persisted with ``project_id=None`` (minted before the target was
resolvable, e.g. an unindexed claude-session lens) renders project-less (blue)
forever, even though the target now resolves an owning project. ``ensure_tab``'s
create-time backfill never runs for it. The fix must be in the list/render path:
backfill a null ``project_id`` from the target server-side for every listed tab.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: F401  (registers type)
from flow_sdk.builtin.tab import Tab, _http_list_all, tab_id_for
from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd

CLAUDE_SID = "18c0c27d-0e5c-4d36-8e4e-7e0224c72229"


@pytest.mark.asyncio
async def test_tab_list_backfills_project_from_unindexed_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # On-disk transcript for the session (cwd → project), NOT indexed.
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

    # A STALE tab row, persisted projectless (as minted before the fix / by an
    # older client). Created directly so it bypasses ensure_tab's create-time
    # backfill — exactly the row the FE re-shows without re-minting.
    pointer = json.dumps({"viewType": "lens", "pointer": f"claude/transcript/{CLAUDE_SID}"})
    tab = Tab(
        id=tab_id_for(pointer),
        pointer=pointer,
        target_type="claude_session",
        target_id=CLAUDE_SID,
        project_id=None,
        visible=True,
    )
    await tab.save()

    # The strip renders from this list. The serialized row must carry the
    # target's project so the chip is project-colored, not blue.
    resp = await _http_list_all(Tab)
    rows = (resp.data or {}).get("tabs", [])
    row = next((r for r in rows if r.get("target_id") == CLAUDE_SID), None)
    assert row is not None, "tab missing from list_all"
    assert row["project_id"] == expected, (
        f"listed tab is projectless (project_id={row['project_id']!r}) — the chip "
        f"renders blue on navigation even though the target resolves {expected!r}"
    )
