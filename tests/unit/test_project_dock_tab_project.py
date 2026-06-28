"""Captures the 'blue tab' for a project-scoped editor dock.

A tab opened under an explicit ``/dock/project/<id>/editor/markdown/...`` URL
persists that project in its pointer (``viewType:"project"``, first path
segment = the project id). But the chip renders projectless (blue) when its
TARGET markdown row is missing: the tab-project resolver derives ONLY from the
target (not found → no project; and a markdown has no on-disk recovery like a
claude session does), and ignores the project sitting right there in the dock
pointer. The fix: when the target resolves no project, fall back to the dock
pointer's own project segment.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.tab import Tab, _http_list_all, tab_id_for

# A markdown id with NO entity row (unindexed / deleted) — the target resolves
# no project, exactly like the production case.
MD = "25c890e6-5cfa-4cd9-b8a5-fd94b16ecfec"


@pytest.mark.asyncio
async def test_project_dock_tab_inherits_pointer_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A real project (the URL's project EXISTS, like prod's flow_tab_heal_p1).
    mount = tmp_path / "flow_tab_heal_p1"
    mount.mkdir()
    pid = Project.derive_id_for_path(str(mount))
    proj = Project(id=pid, name="flow_tab_heal_p1", fs_storage_mount_path=str(mount))
    await proj.save()

    # A stale tab persisted projectless, with the real ``/dock/project/<id>/...``
    # pointer shape — the row the FE re-shows on navigation without re-minting.
    pointer = json.dumps(
        {"viewType": "project", "pointer": f"{pid}/editor/markdown/typeid/markdown-{MD}"}
    )
    tab = Tab(
        id=tab_id_for(pointer),
        pointer=pointer,
        target_type="markdown",
        target_id=MD,
        project_id=None,
        visible=True,
    )
    await tab.save()

    resp = await _http_list_all(Tab)
    rows = (resp.data or {}).get("tabs", [])
    row = next((r for r in rows if r.get("id") == tab.id), None)
    assert row is not None, "tab missing from list_all"
    assert row["project_id"] == pid, (
        f"project-dock tab is projectless (project_id={row['project_id']!r}) — the chip "
        f"renders blue even though the dock pointer names existing project {pid!r}"
    )
