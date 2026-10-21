"""Where a ``flow show`` is presented is decided in the backend (``tab.show_placement``).

The calling process → its one Tab row (every presentation of a process folds onto
``shell|agentic_process-<id>``) → is that row a HOST (Vibe) tab? The answer is
stamped on the show so every client agrees; it used to be each frontend's guess
from the one app-wide view mode, which two sessions shown two ways cannot share.

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.tab import Tab, ensure_tab, process_tab, show_placement

from ._graph_client import call_local

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _pointer(view_type: str, process_id: str) -> str:
    """The stored pointer the frontend writes: the real viewType, the folded tabHash."""
    sub = f"agentic_process-{process_id}"
    return json.dumps({"viewType": view_type, "pointer": sub, "tabHash": f"shell|{sub}"})


async def _open(view_type: str, process_id: str) -> Tab:
    return await ensure_tab(_pointer(view_type, process_id), target_type="agentic_process", target_id=process_id)


@pytest.mark.asyncio
async def test_a_vibe_tab_is_a_host() -> None:
    pid = str(uuid.uuid4())
    tab = await _open("vibe", pid)

    assert await show_placement(pid) == {"tab_id": tab.id, "host": True, "project_id": None}


@pytest.mark.asyncio
async def test_a_terminal_tab_is_not_a_host_and_shows_beside_it() -> None:
    pid = str(uuid.uuid4())
    tab = await _open("shell", pid)

    assert await show_placement(pid) == {"tab_id": tab.id, "host": False, "project_id": None}


@pytest.mark.asyncio
async def test_the_answer_follows_the_tab_when_it_switches_surface() -> None:
    """One row per process: switching it to Vibe re-points the SAME row, and the
    next show sees the host."""
    pid = str(uuid.uuid4())
    shell = await _open("shell", pid)
    vibe = await _open("vibe", pid)

    assert vibe.id == shell.id
    assert (await process_tab(pid)).id == shell.id
    assert (await show_placement(pid))["host"] is True


@pytest.mark.asyncio
async def test_no_open_tab_means_no_anchor() -> None:
    """A background agent (no tab ever) and a closed tab both answer the same:
    nothing to pin into, nothing to sit beside."""
    never = str(uuid.uuid4())
    assert await show_placement(never) == {"tab_id": None, "host": False, "project_id": None}

    closed = str(uuid.uuid4())
    tab = await _open("vibe", closed)
    await tab.close()
    assert await show_placement(closed) == {"tab_id": None, "host": False, "project_id": None}


@pytest.mark.asyncio
async def test_a_show_carries_the_process_project(tmp_path) -> None:
    """The tab minted for a shown file no project owns belongs to the SHOWING
    process's project — through the real ``/show`` action, the route both the
    worker and the user's terminal reach. Proven missing on prod 2026-10-13: a
    snippet shown from a project chat was minted project-less, so the project's
    strip had no chip to light."""
    project = Project(name="show project", fs_storage_mount_path=str(tmp_path))
    await project.save()
    process = AgenticProcess(workdir=str(tmp_path), project_id=project.id, pty_mode=False)
    await process.save()
    tab = await _open("shell", process.id)
    snippet = tmp_path.parent / "snippet.py"  # outside the project
    snippet.write_text("# %% flowpad:snippet\nprint('hi')\n")

    response = await call_local("POST", f"agentic_process/{process.id}/show", json={"path": str(snippet)})

    assert response.status_code == 200, response.text
    shown = await AgenticProcess.get_by_id(process.id)
    assert shown.context_data["show_placement"] == {"tab_id": tab.id, "host": False, "project_id": project.id}


@pytest.mark.asyncio
async def test_cross_project_show_tab_keeps_callers_project(tmp_path) -> None:
    from flow_sdk.builtin.claude_memory_entities import Docs

    caller = Project(name="caller", fs_storage_mount_path=str(tmp_path / "caller"))
    owner = Project(name="owner", fs_storage_mount_path=str(tmp_path / "owner"))
    await caller.save()
    await owner.save()
    doc = Docs(title="Gaps", project_id=owner.id)
    await doc.save()
    pointer = json.dumps({"viewType": "project", "pointer": f"{caller.id}/editor/markdown/typeid/markdown-{doc.id}"})
    response = await call_local("POST", "tab/new_tab", json={
        "pointer": pointer, "target_type": "markdown", "target_id": doc.id, "project_id": owner.id,
    })
    assert response.status_code == 200, response.text
    tab = await Tab.get_one({"pointer": pointer})
    assert tab.project_id == caller.id
    assert (await Docs.get_by_id(doc.id)).project_id == owner.id

    listed = await call_local("GET", "tab/list", params={"project": caller.id})
    assert tab.id in {row["id"] for row in listed.json()["data"]["tabs"]}
    from flow_sdk.builtin.tab import reconcile_tab_project

    await reconcile_tab_project("markdown", doc.id, owner.id)
    assert (await Tab.get_by_id(tab.id)).project_id == caller.id


@pytest.mark.asyncio
async def test_show_placement_uses_the_open_tab_project(tmp_path) -> None:
    project = Project(name="presentation", fs_storage_mount_path=str(tmp_path))
    await project.save()
    process = AgenticProcess(pty_mode=False)
    await process.save()
    tab = await ensure_tab(_pointer("shell", process.id), target_type="agentic_process",
                           target_id=process.id, project_id=project.id)
    assert (await show_placement(process.id))["project_id"] == tab.project_id
