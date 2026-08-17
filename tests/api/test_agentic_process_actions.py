"""HTTP-action coverage for ``AgenticProcess`` — the actions that had only
DEEP_TESTING or no coverage.

Every test drives the documented action surface
(``docs/interface/agentic-process.md``) through the in-process FastAPI app —
real entity, real dispatch — asserting the README invariants and each action's
envelope + core payload. No mocks of the system under test; the only monkeypatch
is the fake-argv CLI seam used to keep the headless drain cheap (no real claude).

Covered here:
  * ``set-visible`` invariant — flips ``visible`` only, never ``pty_mode`` (both
    directions) — README Rule 1.
  * queue family — ``enqueue`` / ``dequeue`` / ``clear-queue`` / ``set-queue-enabled``.
  * ``input`` / ``submit`` — headless staged-queue vs nothing-staged error.
  * ``fork`` — child gets a fresh id, ``fork_session_id`` baked, workdir inherited.
  * ``self-restart`` — ``{scheduled:true}`` + a ``worker.restarted`` entity event.
  * dark reads — ``get-host`` / ``input-dir`` / ``os-status`` /
    ``list-embedded-assets`` / ``transcript`` (plan|prompts|full) / ``get-plan`` /
    ``get-history`` / ``restart-info`` / ``cmd-line`` / ``add-dir`` / ``remove-dir``.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from tests.api.conftest import (
    create_agentic_process,
    default_compute_node_id,
    get_agentic_process,
)
from tests.utils.fake_cli import fake_stream_argv, patch_build_spawn

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


# ---------------------------------------------------------------------------
# set-visible invariant (README Rule 1)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_visible_flips_visible_only_both_directions(bootstrapped_client, user):
    """``set-visible`` mutates ``visible`` and NEVER ``pty_mode`` — both ways."""
    # Start headless-and-hidden: visible=False, pty_mode=False.
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Show the tab. visible → True, pty_mode stays False (transport untouched).
    resp = await bootstrapped_client.post(f"{base}/set-visible", json={"visible": True})
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).data == {"id": pid, "visible": True}
    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["visible"] is True
    assert row["pty_mode"] is False, "set-visible must not touch pty_mode"

    # Hide it again. visible → False, pty_mode STILL False.
    resp = await bootstrapped_client.post(f"{base}/set-visible", json={"visible": False})
    assert resp.status_code == 200, resp.text
    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["visible"] is False
    assert row["pty_mode"] is False


@pytest.mark.asyncio
async def test_set_visible_does_not_touch_pty_mode_true(bootstrapped_client, user):
    """The other quadrant: a PTY-transport process hidden then shown keeps pty_mode=True."""
    pid = await create_agentic_process(bootstrapped_client, visible=True, pty_mode=True)
    base = f"/api/v1/graph/agentic_process/{pid}"

    await bootstrapped_client.post(f"{base}/set-visible", json={"visible": False})
    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["visible"] is False
    assert row["pty_mode"] is True, "set-visible must not touch pty_mode"


@pytest.mark.asyncio
async def test_show_view_resolves_a_screen_and_persists_it(bootstrapped_client, user):
    """`flow show view` — the SCREEN form, the one that needs no entity.

    The address survives onto `last_shown` as the frontend's own dock fields, so
    the client builds its DockPointer without re-parsing a URL.
    """
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/show", json={"view": "assets/list/skill"})
    assert resp.status_code == 200, resp.text
    shown = ApiResponse(**resp.json()).data
    assert shown["kind"] == "dock"
    assert shown["view_type"] == "assets"
    assert shown["pointer"] == "list/skill"
    assert shown["page"] == "desk"

    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["context_data"]["last_shown"] == shown


async def test_show_view_carries_query_options(bootstrapped_client, user):
    """Options ride the address, so `search?q=…` reaches the screen intact."""
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/show", json={"view": "search?q=dock-address"})
    assert resp.status_code == 200, resp.text
    shown = ApiResponse(**resp.json()).data
    assert shown["view_type"] == "search"
    assert shown["options"] == {"q": "dock-address"}


@pytest.mark.parametrize(
    "address",
    ["nonsense", "skills", "helpdesk"],
    ids=["unknown-view", "not-addressable", "pointer-required"],
)
async def test_show_view_rejects_a_bad_address_with_400(bootstrapped_client, user, address):
    """Validation happens before anything is emitted — nothing lands on the stack."""
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/show", json={"view": address})
    assert resp.status_code == 400, resp.text

    row = await get_agentic_process(bootstrapped_client, pid)
    assert "last_shown" not in (row.get("context_data") or {})


async def test_show_last_shown_survives_stale_process_save(bootstrapped_client, user):
    """A transcript/status save from an older AP object must not wipe display focus."""
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"
    stale = await AgenticProcess.get_by_id(pid)
    assert stale is not None
    assert "last_shown" not in (stale.context_data or {})

    resp = await bootstrapped_client.post(f"{base}/show", json={"port": 3000})
    assert resp.status_code == 200, resp.text
    shown = ApiResponse(**resp.json()).data
    assert shown["kind"] == "webapp"

    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["context_data"]["last_shown"] == shown

    stale.status_report = {"kind": "process_status", "status": "ready"}
    await stale.save()

    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["context_data"]["last_shown"] == shown
    assert row["status_report"] == stale.status_report


@pytest.mark.asyncio
async def test_show_appends_display_stack_with_dedupe(bootstrapped_client, user):
    """Each `flow show` APPENDS to ``context_data.display_stack`` (newest last,
    stamped ``shown_at``); ``last_shown`` mirrors the newest TARGET; a consecutive
    identical target refreshes the timestamp instead of duplicating."""
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    r1 = ApiResponse(**(await bootstrapped_client.post(f"{base}/show", json={"port": 3000})).json()).data
    r2 = ApiResponse(**(await bootstrapped_client.post(f"{base}/show", json={"port": 4000})).json()).data

    row = await get_agentic_process(bootstrapped_client, pid)
    stack = row["context_data"]["display_stack"]
    assert len(stack) == 2, "two distinct shows → two entries"
    assert all("shown_at" in e for e in stack), "every entry is timestamped"
    # Each entry is the target payload plus shown_at, newest last.
    assert {k: stack[0][k] for k in r1} == r1
    assert {k: stack[1][k] for k in r2} == r2
    # last_shown is the newest TARGET (no shown_at leak).
    assert row["context_data"]["last_shown"] == r2
    assert "shown_at" not in row["context_data"]["last_shown"]

    # Re-show the SAME target → dedup: still 2 entries, timestamp refreshed.
    prev = stack[1]["shown_at"]
    await bootstrapped_client.post(f"{base}/show", json={"port": 4000})
    row = await get_agentic_process(bootstrapped_client, pid)
    stack2 = row["context_data"]["display_stack"]
    assert len(stack2) == 2, "consecutive identical target must not duplicate"
    assert stack2[1]["shown_at"] >= prev


@pytest.mark.asyncio
async def test_trailing_show_survives_stale_turn_save(bootstrapped_client, user):
    """Regression: a `flow show` with a stale whole-row save AFTER it must survive.

    The real vibe sequence that lost a skill: `flow show` #1 (a dashboard), then
    the worker turn loads the AP (in-memory display_stack=[dashboard]), then
    `flow show` #2 (a skill) appends, then the turn ends and saves the stale
    object. Because show #2 was the LAST show there is no later `on_show` to
    repair it, so the stale save must not clobber it.
    """
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)

    # show 1 — a fresh object (the CLI /show action path)
    s1 = await AgenticProcess.get_by_id(pid)
    await s1.on_show({"kind": "vfs", "path": "/ws/dashboard.html"})

    # worker turn begins — loads the AP AFTER show 1 (holds display_stack=[dashboard])
    turn_obj = await AgenticProcess.get_by_id(pid)
    assert "display_stack" in (turn_obj.context_data or {})

    # show 2 — the skill, via another fresh object
    s2 = await AgenticProcess.get_by_id(pid)
    await s2.on_show({"kind": "entity", "typeid": "skill-abc", "type": "skill", "id": "abc"})

    # worker turn ends — the stale turn object saves status/session bookkeeping
    turn_obj.status = "running"
    await turn_obj.save()

    row = await get_agentic_process(bootstrapped_client, pid)
    entries = [e.get("path") or e.get("type") for e in row["context_data"]["display_stack"]]
    assert "skill" in entries, f"trailing show clobbered by stale turn save: {entries}"
    assert row["context_data"]["last_shown"].get("type") == "skill"


async def _owner_bookmarks(owner, bookmark_type, *, source: str | None = None) -> list:
    """The owner's bookmarks of one type, optionally narrowed to one ``source``
    (``AUTO_SOURCE`` = the machine-built `flow show` tree, never manual stars)."""
    from flow_sdk.builtin.bookmark import Bookmark  # noqa: PLC0415

    query = {"bookmark_type": bookmark_type.value}
    if source is not None:
        query["source"] = source
    return await Bookmark.get_all(query, source_entity=owner)


@pytest.mark.asyncio
async def test_show_auto_bookmarks_into_nested_type_tree(bootstrapped_client, user):
    """Every `flow show` files its target into `Auto / <type> / item` (nested,
    idempotent). Two types → two subfolders under one Auto root; re-showing the
    same target does not duplicate the leaf."""
    from flow_sdk.builtin.bookmark import BookmarkType
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    owner = await get_or_create_local_user()

    async def _favs():
        return (
            await _owner_bookmarks(owner, BookmarkType.FAVORITE_FOLDER),
            await _owner_bookmarks(owner, BookmarkType.FAVORITE),
        )

    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)

    # A resolved skill entity show (payload shape from resolve_display_target).
    ap = await AgenticProcess.get_by_id(pid)
    await ap.on_show({
        "kind": "entity", "typeid": "skill-s1", "type": "skill", "id": "s1",
        "path": "/ws/proj/.claude/skills/traffic-dash/SKILL.md",
    })
    folders, leaves = await _favs()
    root = next(f for f in folders if (f.data or {}).get("auto_root"))
    assert root.title == "Auto"
    skills = next(f for f in folders if (f.data or {}).get("auto_type") == "skill")
    assert skills.title == "Skills" and skills.parent_id == str(root.id)
    leaf = next(b for b in leaves if (b.data or {}).get("entity_id") == "s1")
    assert leaf.source == "auto" and leaf.parent_id == str(skills.id)
    assert leaf.title == "traffic-dash"  # folder-main file → parent folder name

    # A markdown show → a SECOND subfolder under the SAME Auto root.
    ap2 = await AgenticProcess.get_by_id(pid)
    await ap2.on_show({
        "kind": "entity", "typeid": "markdown-m1", "type": "markdown", "id": "m1",
        "path": "/ws/proj/docs/release-notes.md",
    })
    folders, leaves = await _favs()
    roots = [f for f in folders if (f.data or {}).get("auto_root")]
    assert len(roots) == 1, "one Auto root, not one per type"
    docs = next(f for f in folders if (f.data or {}).get("auto_type") == "markdown")
    assert docs.title == "Documents" and docs.parent_id == str(root.id)

    # Re-show the skill → idempotent (no duplicate leaf, no duplicate subfolder).
    ap3 = await AgenticProcess.get_by_id(pid)
    await ap3.on_show({
        "kind": "entity", "typeid": "skill-s1", "type": "skill", "id": "s1",
        "path": "/ws/proj/.claude/skills/traffic-dash/SKILL.md",
    })
    folders, leaves = await _favs()
    assert len([f for f in folders if (f.data or {}).get("auto_type") == "skill"]) == 1
    assert len([b for b in leaves if (b.data or {}).get("entity_id") == "s1"]) == 1


@pytest.mark.asyncio
async def test_show_auto_bookmarks_are_project_scoped(bootstrapped_client, user, tmp_path):
    """A `flow show` files its auto favorite into the SHOWING PROJECT's tree — two
    projects get their own stamped root and leaf, or one project's slider shows
    every other project's shows (unscoped rows are global — see bookmark-scope.ts).
    """
    from flow_sdk.builtin.bookmark import AUTO_SOURCE, BookmarkType
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    owner = await get_or_create_local_user()
    payload = {
        "kind": "entity", "typeid": "markdown-shared", "type": "markdown", "id": "shared",
        "path": str(tmp_path / "notes.md"),
    }

    async def _auto(bookmark_type: BookmarkType) -> list:
        return await _owner_bookmarks(owner, bookmark_type, source=AUTO_SOURCE)

    proj_a = Project(name="fav-scope-a", fs_storage_mount_path=str(tmp_path / "a"))
    proj_b = Project(name="fav-scope-b", fs_storage_mount_path=str(tmp_path / "b"))
    await proj_a.save()
    await proj_b.save()

    pids = {}
    for project in (proj_a, proj_b):
        pids[project.id] = await create_agentic_process(
            bootstrapped_client, visible=False, pty_mode=False, project_id=project.id
        )
        await (await AgenticProcess.get_by_id(pids[project.id])).on_show(payload)

    leaves = [b for b in await _auto(BookmarkType.FAVORITE) if (b.data or {}).get("entity_id") == "shared"]
    assert {b.project_id for b in leaves} == {proj_a.id, proj_b.id}, (
        f"one leaf per showing project, each stamped: {[(b.project_id, b.title) for b in leaves]}"
    )

    # One Auto root per project. (Other rows in this shared DB may carry no
    # project — a project-less show is legitimately unscoped — so assert on this
    # test's two projects, not on the whole set.)
    roots = [f for f in await _auto(BookmarkType.FAVORITE_FOLDER) if (f.data or {}).get("auto_root")]
    for project in (proj_a, proj_b):
        assert len([f for f in roots if f.project_id == project.id]) == 1, (
            f"expected exactly one Auto root for {project.name}: "
            f"{[(f.project_id, f.id) for f in roots]}"
        )

    # Re-showing from project A is still idempotent WITHIN its own tree — it must
    # not adopt B's root or mint a second leaf.
    await (await AgenticProcess.get_by_id(pids[proj_a.id])).on_show(payload)
    again = [b for b in await _auto(BookmarkType.FAVORITE) if (b.data or {}).get("entity_id") == "shared"]
    assert len(again) == 2, "re-show must not duplicate within a project"

    # A project-less process keeps the legacy unscoped row (global favorite).
    pid_none = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)
    await (await AgenticProcess.get_by_id(pid_none)).on_show(payload)
    unscoped = [
        b
        for b in await _auto(BookmarkType.FAVORITE)
        if (b.data or {}).get("entity_id") == "shared" and not b.project_id
    ]
    assert len(unscoped) == 1, "project-less show mints exactly one unscoped favorite"


@pytest.mark.asyncio
async def test_on_show_unions_concurrent_appends(bootstrapped_client, user):
    """``on_show`` is read-modify-write against the freshest stack, so two
    independent process objects showing different targets don't lose each other."""
    pid = await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)

    a = await AgenticProcess.get_by_id(pid)
    b = await AgenticProcess.get_by_id(pid)
    assert a is not None and b is not None
    await a.on_show({"kind": "vfs", "path": "/tmp/a.txt"})
    await b.on_show({"kind": "vfs", "path": "/tmp/b.txt"})

    row = await get_agentic_process(bootstrapped_client, pid)
    paths = [e.get("path") for e in row["context_data"]["display_stack"]]
    assert "/tmp/a.txt" in paths and "/tmp/b.txt" in paths, "neither concurrent append is lost"


@pytest.mark.asyncio
async def test_register_webapp_artifact_attaches_to_project_and_shows(bootstrapped_client, user, tmp_path):
    project = Project(name="app-proj", fs_storage_mount_path=str(tmp_path))
    await project.save()
    app_dir = tmp_path / "frontend"
    app_dir.mkdir()
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(tmp_path),
        project_id=project.id,
    )
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(
        f"{base}/register-webapp-artifact",
        json={
            "name": "Frontend",
            "path": str(app_dir),
            "port": "3300",
            "start_cmd": "npm run dev",
            "health": "/",
            "show": True,
        },
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    artifact = data["artifact"]
    deployment = data["deployment"]
    assert artifact["kind"] == "application.web"
    assert artifact["origin"] == {
        "kind": "local",
        "base": str(tmp_path),
        "rel_path": "frontend",
        "project_id": "",
    }
    assert deployment["kind"] == "runtime.web"
    assert deployment["artifact_id"] == artifact["id"]
    assert deployment["provider_labels"]["flowpad.runtime.port"] == "3300"
    # The pin is the APP, not the port: a port is one of two ways to reach it
    # and changes between runs, while the artifact id stays true. Runtime is
    # derived from the companions — dev here, since there is no build output.
    assert data["shown"] == {
        "kind": "app",
        "artifact_id": artifact["id"],
        "typeid": f"artifact-{artifact['id']}",
        "name": "Frontend",
        "runtime": "dev",
        "port": 3300,
    }
    # No dist/ in this app yet, so it has no delivery companion.
    assert data["micro_app"] is None

    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["context_data"]["last_shown"] == data["shown"]

    listed = await bootstrapped_client.post(f"{base}/webapp-artifacts", json={})
    listed_data = ApiResponse(**listed.json()).data
    assert [item["id"] for item in listed_data["artifacts"]] == [artifact["id"]]
    assert listed_data["artifacts"][0]["deployment"]["id"] == deployment["id"]

    # Kind filters honor exact-or-descendant ontology semantics.
    artifact_entity = await Artifact.get_by_id(artifact["id"])
    deployment_entity = await Deployment.get_by_id(deployment["id"])
    assert artifact_entity is not None and deployment_entity is not None
    artifact_entity.kind = "application.web.react"
    deployment_entity.kind = "runtime.web.vite"
    await artifact_entity.save(notify=False)
    await deployment_entity.save(notify=False)
    descendant_list = await bootstrapped_client.post(f"{base}/webapp-artifacts", json={})
    descendant_data = ApiResponse(**descendant_list.json()).data
    assert [item["id"] for item in descendant_data["artifacts"]] == [artifact["id"]]
    assert descendant_data["artifacts"][0]["deployment"]["id"] == deployment["id"]

    update = await bootstrapped_client.post(
        f"{base}/register-webapp-artifact",
        json={
            "name": "Frontend",
            "path": str(app_dir),
            "port": "3301",
            "start_cmd": "npm run dev -- --port 3301",
            "show": False,
        },
    )
    updated_data = ApiResponse(**update.json()).data
    updated = updated_data["artifact"]
    assert updated["id"] == artifact["id"]
    assert updated_data["deployment"]["id"] == deployment["id"]
    assert updated_data["deployment"]["provider_labels"]["flowpad.runtime.port"] == "3301"


@pytest.mark.asyncio
async def test_register_webapp_artifact_mints_delivery_micro_app(bootstrapped_client, user, tmp_path):
    """Built output gets a MicroApp — the delivery companion of the same Artifact.

    Artifact (source) → Deployment (runtime) → MicroApp (delivery) is one app in
    three planes, so the delivery row must hang off the SAME artifact id and be
    updated, never forked, when the app is re-registered.
    """
    from flow_sdk.builtin.faas.micro_app import AppLocationType, MicroApp

    project = Project(name="served-proj", fs_storage_mount_path=str(tmp_path))
    await project.save()
    app_dir = tmp_path / "todo"
    (app_dir / "dist").mkdir(parents=True)
    (app_dir / "dist" / "index.html").write_text("<html><body>todo</body></html>")
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(tmp_path),
        project_id=project.id,
    )
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(
        f"{base}/register-webapp-artifact",
        json={"name": "Todo", "path": str(app_dir), "port": "3400", "show": True},
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    artifact, micro_app = data["artifact"], data["micro_app"]

    # dist/ was discovered without being named in the request.
    assert micro_app is not None
    assert micro_app["artifact_id"] == artifact["id"]
    assert micro_app["location_type"] == AppLocationType.Artifact.value
    assert micro_app["location_root"] == str(app_dir / "dist")
    assert micro_app["project_id"] == project.id

    # Both runtimes exist; a live port wins for display purposes.
    assert data["shown"]["runtime"] == "dev"
    assert data["shown"]["micro_app_id"] == micro_app["id"]

    # Re-registering updates the same delivery row rather than forking one.
    again = await bootstrapped_client.post(
        f"{base}/register-webapp-artifact",
        json={"name": "Todo", "path": str(app_dir), "port": "3401", "dist": "dist", "show": False},
    )
    again_app = ApiResponse(**again.json()).data["micro_app"]
    assert again_app["id"] == micro_app["id"]

    rows = await MicroApp.get_all({"artifact_id": artifact["id"]})
    assert len(rows) == 1

    # An app named the same as another must still save: name is a label, not an
    # identity, and per-type global uniqueness would 409 the second one.
    other_dir = tmp_path / "todo-two"
    (other_dir / "dist").mkdir(parents=True)
    (other_dir / "dist" / "index.html").write_text("<html><body>two</body></html>")
    twin = await bootstrapped_client.post(
        f"{base}/register-webapp-artifact",
        json={"name": "Todo", "path": str(other_dir), "port": "3402", "show": False},
    )
    assert twin.status_code == 200, twin.text
    twin_app = ApiResponse(**twin.json()).data["micro_app"]
    assert twin_app is not None and twin_app["id"] != micro_app["id"]


@pytest.mark.asyncio
async def test_registering_without_a_port_yields_a_served_app(bootstrapped_client, user, tmp_path):
    """An app Flowpad serves itself has no dev server, so it has no Deployment.

    This is the shape that lets a generated app use the SDK: served from our own
    origin, it is handed the API origin and the session cookies. Minting a
    Deployment for a port nobody is listening on would make the display derive
    `dev` and point at nothing.
    """
    from flow_sdk.builtin.faas.micro_app import MicroApp

    project = Project(name="served-only-proj", fs_storage_mount_path=str(tmp_path))
    await project.save()
    app_dir = tmp_path / "task-manager"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<html><body>tasks</body></html>")
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(tmp_path),
        project_id=project.id,
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/register-webapp-artifact",
        json={"name": "Task Manager", "path": str(app_dir), "show": True},
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data

    assert data["artifact"]["kind"] == "application.web"
    assert data["deployment"] is None
    assert data["micro_app"]["artifact_id"] == data["artifact"]["id"]
    assert await Deployment.get_one({"artifact_id": data["artifact"]["id"]}) is None

    # The display resolves to the served runtime, with no port to point at.
    assert data["shown"]["kind"] == "app"
    assert data["shown"]["runtime"] == "served"
    assert "port" not in data["shown"]

    rows = await MicroApp.get_all({"artifact_id": data["artifact"]["id"]})
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_a_malformed_port_is_still_rejected(bootstrapped_client, user, tmp_path):
    """Omitting the port is now legal; sending a bad one is still an error —
    otherwise a typo would silently downgrade an app to served-only."""
    project = Project(name="bad-port-proj", fs_storage_mount_path=str(tmp_path))
    await project.save()
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    pid = await create_agentic_process(
        bootstrapped_client, visible=False, pty_mode=False, workdir=str(tmp_path), project_id=project.id
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/register-webapp-artifact",
        json={"name": "App", "path": str(app_dir), "port": "not-a-port", "show": False},
    )
    assert resp.status_code == 400
    assert ApiResponse(**resp.json()).status == ApiResponseStatus.FAIL.value


@pytest.mark.asyncio
async def test_static_app_folder_is_its_own_build_output(bootstrapped_client, user, tmp_path):
    """A static app has no build step: the registered folder IS the deliverable.

    `flow app open` discovers static apps by finding index.html and registers
    that directory, so requiring a nested dist/ would deny a delivery companion
    to exactly the apps that need no work to serve.
    """
    project = Project(name="static-proj", fs_storage_mount_path=str(tmp_path))
    await project.save()
    app_dir = tmp_path / "static-todo"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<html><body>static todo</body></html>")
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(tmp_path),
        project_id=project.id,
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/register-webapp-artifact",
        json={"name": "Static Todo", "path": str(app_dir), "port": "8123", "show": False},
    )
    assert resp.status_code == 200, resp.text
    micro_app = ApiResponse(**resp.json()).data["micro_app"]
    assert micro_app is not None
    assert micro_app["location_root"] == str(app_dir)


@pytest.mark.asyncio
async def test_register_webapp_artifact_stamps_git_origin(bootstrapped_client, user, tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, capture_output=True)
    repo = tmp_path / "repo"
    subprocess.run(["git", "clone", "-q", remote.resolve().as_uri(), str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "checkout", "-q", "-b", "feature/webapp"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.test"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True, capture_output=True)
    app_dir = repo / "frontend"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("hello from git webapp\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "webapp"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "push", "-q", "-u", "origin", "feature/webapp"], cwd=repo, check=True, capture_output=True)

    project = Project(name="git-webapp", fs_storage_mount_path=str(repo))
    await project.save()
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(repo),
        project_id=project.id,
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/register-webapp-artifact",
        json={
            "name": "Git Frontend",
            "path": str(app_dir),
            "port": "3302",
            "show": False,
        },
    )
    assert resp.status_code == 200, resp.text
    artifact = ApiResponse(**resp.json()).data["artifact"]
    assert artifact["origin"]["kind"] == "git"
    assert artifact["origin"]["provider"] == "file"
    assert artifact["origin"]["branch"] == "feature/webapp"
    assert artifact["origin"]["rel_path"] == "frontend"


# ---------------------------------------------------------------------------
# Prompt queue family
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_enqueue_dequeue_clear_and_enabled(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Disable the queue up front so the auto-drain (scheduled by enqueue) can't
    # pop + run entries out from under the assertions — we're testing the queue
    # mechanics, not the drain.
    re = await bootstrapped_client.post(f"{base}/set-queue-enabled", json={"enabled": False})
    assert ApiResponse(**re.json()).data["enabled"] is False

    # enqueue — prompt is required.
    bad = await bootstrapped_client.post(f"{base}/enqueue", json={})
    assert ApiResponse(**bad.json()).status == ApiResponseStatus.FAIL.value

    # enqueue two entries; both persist (queue disabled → no drain).
    r1 = await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": "one"})
    assert r1.status_code == 200, r1.text
    assert [e["prompt"] for e in ApiResponse(**r1.json()).data["entries"]] == ["one"]
    r2 = await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": "two"})
    q2 = ApiResponse(**r2.json()).data
    assert [e["prompt"] for e in q2["entries"]] == ["one", "two"]
    first_id = q2["entries"][0]["id"]

    # dequeue by id removes exactly that entry.
    rd = await bootstrapped_client.post(f"{base}/dequeue", json={"id": first_id})
    assert rd.status_code == 200, rd.text
    assert [e["prompt"] for e in ApiResponse(**rd.json()).data["entries"]] == ["two"]

    # dequeue with neither id nor index → error.
    bad_dq = await bootstrapped_client.post(f"{base}/dequeue", json={})
    assert ApiResponse(**bad_dq.json()).status == ApiResponseStatus.FAIL.value

    # clear-queue empties entries (enabled flag preserved).
    rc = await bootstrapped_client.post(f"{base}/clear-queue")
    cleared = ApiResponse(**rc.json()).data
    assert cleared["entries"] == []
    assert cleared["enabled"] is False


@pytest.mark.asyncio
async def test_multi_entry_queue_drains_every_headless_entry(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """VIBE-005: stage 3 entries with draining OFF, then turn draining ON — all
    three must dequeue, not just the first.

    Only the ``claude`` binary is faked (the real ``ClaudeCLIStreamWorker`` /
    ``_run_turn`` / ``_turn_in_flight`` lifecycle runs); the queue-drain logic
    under test is untouched. The bug: headless ``prompt()`` returns after
    *scheduling* ``_run_turn`` (driver.py: ``asyncio.create_task``), not after
    completion, so the chained drain in ``_maybe_drain_queue``'s ``finally``
    fires while the first turn is still in flight, bails ``not_ready``, and
    nothing re-triggers a drain once the turn completes.
    """
    # A brief turn so the chain drain genuinely races an in-flight worker.
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            [{"type": "result", "subtype": "success", "is_error": False, "session_id": "sid"}],
            delay_ms=50,
        ),
    )
    pid = await create_agentic_process(
        bootstrapped_client, pty_mode=False, workdir=str(tmp_path)
    )
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Stage three ordered entries with draining OFF (no drain yet).
    await bootstrapped_client.post(f"{base}/set-queue-enabled", json={"enabled": False})
    staged = ["one", "two", "three"]
    for prompt in staged:
        await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": prompt})

    ap = await AgenticProcess.get_one({"id": pid})
    assert [e["prompt"] for e in ap.queue.entries] == staged, "staging order lost"

    # Turn draining ON and drive the drain deterministically. Each headless
    # turn is a background ``_run_turn`` task that, on completion, schedules the
    # next drain — so await the whole cascade (worker turns + drain tasks) until
    # the queue settles. No sleeps/timeouts: this only awaits real tasks the
    # drain machinery spawns, which is finite for a finite queue.
    ap.queue.set_enabled(True)

    def _related(t: asyncio.Task) -> bool:
        if t is asyncio.current_task() or t.done():
            return False
        qual = getattr(t.get_coro(), "__qualname__", "")
        return (t.get_name() or "").startswith("claude-") or "_maybe_drain_queue" in qual

    await ap._maybe_drain_queue("enable")
    for _ in range(30):
        pending = [t for t in asyncio.all_tasks() if _related(t)]
        if not pending:
            break
        await asyncio.gather(*pending, return_exceptions=True)

    # Every staged entry should have become a turn exactly once, in order.
    assert ap.queue.entries == [], (
        "queue stranded after the first headless turn: "
        f"{[e['prompt'] for e in ap.queue.entries]}"
    )


# ---------------------------------------------------------------------------
# input / submit — headless staged-queue vs nothing-staged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_input_stages_onto_queue_headless(bootstrapped_client, user):
    """``input`` on a cold/headless process stages onto the PERSISTED queue."""
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"
    await bootstrapped_client.post(f"{base}/set-queue-enabled", json={"enabled": False})

    resp = await bootstrapped_client.post(f"{base}/input", json={"text": "staged line"})
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["staged"] is True
    assert data["status"] == "queued"

    # The staged line is durable on the queue (survives a separate request).
    q = await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": "second"})
    pending_drains = [
        task
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
        and "_maybe_drain_queue" in getattr(task.get_coro(), "__qualname__", "")
    ]
    await asyncio.gather(*pending_drains, return_exceptions=True)
    prompts = [e["prompt"] for e in ApiResponse(**q.json()).data["entries"]]
    assert prompts == ["staged line", "second"]


@pytest.mark.asyncio
async def test_submit_nothing_staged_headless_fails(bootstrapped_client, user):
    """``submit`` on a headless process with an empty queue is a documented error."""
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/submit", json={}
    )
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.FAIL.value
    assert "nothing to submit" in (res.message or "").lower()


@pytest.mark.asyncio
async def test_submit_with_staged_head_schedules_drain(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """``submit`` with a staged head commits the turn (schedules the drain)."""
    # Cheap CLI seam: emit a terminal ``result`` line then exit (no real claude).
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            [{"type": "result", "subtype": "success", "is_error": False, "session_id": "fake-sid"}]
        ),
    )
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False, workdir=str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    await bootstrapped_client.post(f"{base}/input", json={"text": "go"})
    resp = await bootstrapped_client.post(f"{base}/submit", json={})
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).data["status"] == "submitted"


# ---------------------------------------------------------------------------
# fork
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fork_creates_sibling_with_new_id_and_fork_source(bootstrapped_client, user, tmp_path):
    """``fork`` mints a NEW process id, bakes ``fork_session_id=<parent>`` into
    cli_config, and inherits the parent's workdir (README fork contract)."""
    parent_sid = str(uuid.uuid4())
    parent_id = await create_agentic_process(
        bootstrapped_client,
        session_id=parent_sid,
        workdir=str(tmp_path),
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{parent_id}/fork", json={"visible": False}
    )
    assert resp.status_code == 200, resp.text
    child_ref = ApiResponse(**resp.json()).data
    child_id = child_ref["id"]
    assert child_id != parent_id, "fork must mint a new entity id"
    assert child_ref["type"] == "agentic_process"

    child = await get_agentic_process(bootstrapped_client, child_id)
    assert child["workdir"] == str(tmp_path), "fork inherits the parent workdir"
    assert child["session_id"] != parent_sid, "fork gets its own fresh session id"
    cli = child["cli_config"] or {}
    assert cli.get("fork_session_id") == parent_sid, "fork source baked into cli_config"
    assert cli.get("session_id") == child["session_id"]
    assert cli.get("resume") is True


# ---------------------------------------------------------------------------
# self-restart — {scheduled:true} + worker.restarted entity event
# ---------------------------------------------------------------------------


def _make_fake_claude_jsonl(session_id: str) -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    projects_dir = get_instance_settings().claude_projects_dir / "test-self-restart"
    projects_dir.mkdir(parents=True, exist_ok=True)
    path = projects_dir / f"{session_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "user",
                "sessionId": session_id,
                "cwd": "/tmp",
                "version": "1.0",
                "uuid": str(uuid.uuid4()),
                "timestamp": "2024-01-01T00:00:00.000Z",
                "message": {"role": "user", "content": "hi"},
            }
        )
    )
    return path


@pytest.mark.asyncio
async def test_self_restart_schedules_and_emits_worker_restarted(
    bootstrapped_client, user, bootstrap_payload, monkeypatch
):
    """``self-restart`` returns ``{scheduled:true}`` immediately and, once the
    detached restart completes, emits a ``worker.restarted`` entity event."""
    cn_id = default_compute_node_id(bootstrap_payload)
    session_id = str(uuid.uuid4())
    jsonl = _make_fake_claude_jsonl(session_id)

    # Capture the outbound entity-event boundary (the WS notification the UI
    # bridges to a terminal re-attach). We still run the real exit()+start_pty().
    emitted: list[str] = []
    orig_emit = AgenticProcess.emit_entity_event

    async def _spy(self, event, payload=None):
        emitted.append(event)
        return await orig_emit(self, event, payload)

    monkeypatch.setattr(AgenticProcess, "emit_entity_event", _spy, raising=True)

    try:
        # Post-restart state: a running shell + running process bound to the session.
        shell_resp = await bootstrapped_client.post(
            "/api/v1/graph/shell",
            json={
                "name": f"Claude - {session_id[:8]}",
                "status": "running",
                "compute_node_id": cn_id,
                "compute_node_uname": "local",
            },
        )
        shell_id = ApiResponse(**shell_resp.json()).data["id"]
        pid = await create_agentic_process(
            bootstrapped_client,
            shell_id=shell_id,
            session_id=session_id,
            status="running",
        )
        base = f"/api/v1/graph/agentic_process/{pid}"

        resp = await bootstrapped_client.post(f"{base}/self-restart", json={})
        assert resp.status_code == 200, resp.text
        sched = ApiResponse(**resp.json()).data
        assert sched["scheduled"] is True
        assert sched["id"] == pid

        # The detached restart runs out-of-band (grace + exit + start_pty). Wait
        # for the worker.restarted event it emits on success.
        deadline = time.monotonic() + 20
        while "worker.restarted" not in emitted and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        assert "worker.restarted" in emitted, (
            "self-restart must emit worker.restarted after the detached restart"
        )
    finally:
        jsonl.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_wizard_close_entity_event_action_returns_typed_result(bootstrapped_client, user):
    pid = await create_agentic_process(
        bootstrapped_client,
        status="running",
        visible=False,
        pty_mode=False,
    )
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/entity-event",
        json={
            "event": "wizard.close",
            "payload": {"status": "done", "data": {"localPath": "/tmp/app"}},
        },
    )

    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["status"] == "ok"
    result = data["result"]
    assert result["status"] == "done"
    assert result["data"] == {"localPath": "/tmp/app"}
    assert result["wizardId"] == pid


# ---------------------------------------------------------------------------
# Dark read actions — one envelope + core-payload assertion each
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_host_resolves_local_port(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    # POST with a real JSON bool for ``redirect`` (a "false" query string coerces
    # truthy and would yield a RedirectResponse instead of the JSON envelope).
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/get-host",
        json={"port": 5173, "redirect": False},
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["port"] == 5173
    assert isinstance(data["url"], str) and data["url"]


@pytest.mark.asyncio
async def test_get_host_rejects_out_of_range_port(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/get-host?port=80&redirect=false"
    )
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.FAIL.value


@pytest.mark.asyncio
async def test_input_dir_returns_abs_path_and_compute_node(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/input-dir"
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert Path(data["abs_path"]).is_dir()
    assert data["compute_node_id"].startswith("compute_node-")


@pytest.mark.asyncio
async def test_os_status_headline_ready_false_no_shell(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/os-status"
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["process_id"] == pid
    assert data["ready"] is False
    assert data["reason"] == "no shell linked to process"


@pytest.mark.asyncio
async def test_list_embedded_assets_empty(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/list-embedded-assets"
    )
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).data == {"refs": []}


@pytest.mark.asyncio
async def test_transcript_prompts_full_and_plan_no_session(bootstrapped_client, user):
    """With no session/transcript the three transcript sub-paths return their
    documented empty envelopes (never a 404)."""
    pid = await create_agentic_process(bootstrapped_client)
    base = f"/api/v1/graph/agentic_process/{pid}"

    rp = await bootstrapped_client.post(f"{base}/transcript/prompts")
    assert rp.status_code == 200, rp.text
    assert ApiResponse(**rp.json()).data == {"prompts": []}

    rf = await bootstrapped_client.post(f"{base}/transcript/full")
    assert rf.status_code == 200, rf.text
    full = ApiResponse(**rf.json()).data
    assert full["entries"] == []
    assert full["session_id"] is None
    assert "worker_type" in full

    rplan = await bootstrapped_client.post(f"{base}/transcript/plan")
    assert rplan.status_code == 200, rplan.text
    assert ApiResponse(**rplan.json()).data == {"markdown": None, "plan_path": None}


@pytest.mark.asyncio
async def test_transcript_unknown_subpath_fails(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/transcript/bogus"
    )
    assert ApiResponse(**resp.json()).status == ApiResponseStatus.FAIL.value


@pytest.mark.asyncio
async def test_get_plan_alias_no_session(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/get-plan"
    )
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).data == {"markdown": None, "plan_path": None}


@pytest.mark.asyncio
async def test_get_history_empty_is_success(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/get-history"
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["history"] == []
    assert data["count"] == 0
    assert data["use_worker_history"] is True


@pytest.mark.asyncio
async def test_restart_info_no_baseline(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/restart-info"
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["restart_required"] is False
    assert data["running"] is False
    # No successful start yet → no baseline snapshot, nothing has drifted.
    assert data["loaded"] is None
    assert data["changed"] == []


@pytest.mark.asyncio
async def test_cmd_line_action_returns_key(bootstrapped_client, user):
    pid = await create_agentic_process(bootstrapped_client)
    resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{pid}/cmd-line"
    )
    assert resp.status_code == 200, resp.text
    # Failure-tolerant: always carries the ``cmd_line`` key (str or None).
    assert "cmd_line" in ApiResponse(**resp.json()).data


@pytest.mark.asyncio
async def test_add_dir_then_remove_dir(bootstrapped_client, user, tmp_path):
    pid = await create_agentic_process(bootstrapped_client)
    base = f"/api/v1/graph/agentic_process/{pid}"
    extra = str(tmp_path)

    ra = await bootstrapped_client.post(f"{base}/add-dir", json={"path": extra})
    assert ra.status_code == 200, ra.text
    assert extra in (await get_agentic_process(bootstrapped_client, pid))["additional_dirs"]

    rr = await bootstrapped_client.post(f"{base}/remove-dir", json={"path": extra})
    assert rr.status_code == 200, rr.text
    assert extra not in ((await get_agentic_process(bootstrapped_client, pid))["additional_dirs"] or [])
