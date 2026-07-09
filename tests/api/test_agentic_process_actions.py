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
    assert artifact["artifact_type"] == "WEBAPP"
    assert artifact["ref_type"] == "FOLDER"
    assert artifact["path"] == str(app_dir)
    assert artifact["port"] == "3300"
    assert data["shown"] == {"kind": "webapp", "port": 3300}

    row = await get_agentic_process(bootstrapped_client, pid)
    assert row["context_data"]["last_shown"] == data["shown"]

    listed = await bootstrapped_client.post(f"{base}/webapp-artifacts", json={})
    listed_data = ApiResponse(**listed.json()).data
    assert [item["id"] for item in listed_data["artifacts"]] == [artifact["id"]]

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
    updated = ApiResponse(**update.json()).data["artifact"]
    assert updated["id"] == artifact["id"]
    assert updated["port"] == "3301"


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
    assert artifact["git_origin"]["provider"] == "file"
    assert artifact["git_origin"]["branch"] == "feature/webapp"
    assert artifact["git_origin"]["rel_path"] == "frontend"
    assert artifact["metadata"]["git_origin"]["rel_path"] == "frontend"


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


# ---------------------------------------------------------------------------
# input / submit — headless staged-queue vs nothing-staged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_input_stages_onto_queue_headless(bootstrapped_client, user):
    """``input`` on a cold/headless process stages onto the PERSISTED queue."""
    pid = await create_agentic_process(bootstrapped_client, pty_mode=False)
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/input", json={"text": "staged line"})
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    assert data["staged"] is True
    assert data["status"] == "queued"

    # The staged line is durable on the queue (survives a separate request).
    q = await bootstrapped_client.post(f"{base}/enqueue", json={"prompt": "second"})
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
