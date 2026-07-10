"""Headless ``execute`` / ``prompt`` / ``cancel-prompt`` round-trips via HTTP.

Fills the 0-byte placeholder. Drives the documented ``AgenticProcess`` HTTP
action surface (``docs/interface/agentic-process.md``) through the in-process
FastAPI app — real entity, real dispatch, real subprocess — with the CLI
binary replaced by a cheap ``bash`` fake so no real ``claude`` is spawned.

The fake follows the established fake-argv pattern: it monkeypatches
``ClaudeCLIStreamWorker._build_spawn`` (the single seam the print-mode worker
uses to build its subprocess) to emit two ``stream-json`` lines — a
``system:init`` carrying the session id and a terminal ``result`` — so the
worker's ``execute()`` runs a genuine (tiny) subprocess and produces FlowData.
This is a real cheap subprocess, not a mock of the system under test.

Invariants pinned (README.md Rules):
  * Rule 1 — ``pty_mode=False`` routes to the headless JSON-stream transport.
  * ``execute`` action delegates to ``prompt`` (fresh-start headless turn) and
    the worker's session id is captured + persisted onto the entity.
  * ``prompt`` action streams FlowData chunks and closes with an end frame.
  * ``cancel-prompt`` SIGTERMs the in-flight print-mode worker; with no
    in-flight worker it fails.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS, AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker import (
    CodexCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.turn_abort import turn_events_path
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from tests.api.conftest import create_agentic_process, get_agentic_process
from tests.utils.fake_cli import fake_stream_argv, patch_build_spawn

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


_FAKE_SID = "fake-session-id"


def _fake_stream_lines(lines: list[dict]) -> list[dict]:
    """Stamp the fake session id onto each stream-json line (the worker captures
    it from the stream) — the headless process is created with no preassigned
    session id, so this stands in for the fallback the real worker would emit."""
    return [{**obj, "session_id": _FAKE_SID} for obj in lines]


async def _create_headless_process(client, workdir: str) -> str:
    pid = await create_agentic_process(client, pty_mode=False, workdir=workdir)
    # pty_mode must persist as the transport intent (Rule 1).
    assert (await get_agentic_process(client, pid))["pty_mode"] is False
    return pid


@pytest.mark.asyncio
async def test_execute_headless_round_trip_captures_session_id(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """``execute`` on a headless process runs a print-mode turn and persists the
    session id the worker reported."""
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            _fake_stream_lines(
                [
                    {"type": "system", "subtype": "init"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": "ok"},
                ]
            )
        ),
        env=dict(os.environ),
    )

    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hi"})
    assert resp.status_code == 200, resp.text
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.SUCCESS.value, res

    # execute is fire-and-forget; the turn runs as a background task. Wait for it
    # to finish (worker deregistered) then assert the session id was persisted.
    deadline = time.monotonic() + 20
    while pid in _PROMPT_WORKERS and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert pid not in _PROMPT_WORKERS, "headless turn never completed"

    got = await bootstrapped_client.get(base)
    session_id = ApiResponse(**got.json()).data["session_id"]
    assert session_id, "worker session id must be persisted after the turn"


@pytest.mark.asyncio
async def test_execute_requires_instruction(bootstrapped_client, user, tmp_path):
    """``execute`` with no instruction fails (documented precondition)."""
    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/execute", json={}
    )
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.FAIL.value
    assert "instruction" in (res.message or "").lower()


@pytest.mark.asyncio
async def test_prompt_headless_streams_flowdata_and_end(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """The ``prompt`` action streams FlowData chunks for a headless turn and the
    reported session id is persisted onto the entity."""
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            _fake_stream_lines(
                [
                    {"type": "system", "subtype": "init"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": "done"},
                ]
            )
        ),
        env=dict(os.environ),
    )

    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    body = b""
    async with bootstrapped_client.stream(
        "POST", f"{base}/prompt", json={"message": "hello"}
    ) as resp:
        assert resp.status_code == 200, resp.status_code
        async for chunk in resp.aiter_bytes():
            body += chunk

    assert body, "prompt must stream at least one FlowData chunk"
    text = body.decode("utf-8", errors="replace")
    # A worker error would surface as a 'prompt error' status frame.
    assert "prompt error" not in text, text[:500]

    got = await bootstrapped_client.get(base)
    # The worker echoes back whatever session id the turn ran under (a preassigned
    # id or the fake fallback) and the handler persists it onto the entity.
    assert ApiResponse(**got.json()).data["session_id"]
    entity = ApiResponse(**got.json()).data
    assert entity["restart_required"] is False
    assert entity["last_started_snapshot"]["generic"]["session_id"] == entity["session_id"]


@pytest.mark.asyncio
async def test_prompt_requires_message(bootstrapped_client, user, tmp_path):
    """``prompt`` with an empty message is rejected before any worker spawn."""
    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/prompt", json={"message": "   "}
    )
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.FAIL.value
    assert "message" in (res.message or "").lower()


@pytest.mark.asyncio
async def test_cancel_prompt_terminates_in_flight_turn(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """``cancel-prompt`` SIGTERMs the in-flight print-mode worker."""
    patch_build_spawn(
        monkeypatch, ClaudeCLIStreamWorker, ["bash", "-c", "sleep 30"], env=dict(os.environ)
    )

    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hang"})
    assert resp.status_code == 200, resp.text

    # Wait until the worker's subprocess is actually live before cancelling, so the
    # SIGTERM has a target (avoids a leaked ``sleep`` subprocess).
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        worker = _PROMPT_WORKERS.get(pid)
        if worker is not None and getattr(worker, "_proc", None) is not None:
            break
        await asyncio.sleep(0.02)
    worker = _PROMPT_WORKERS.get(pid)
    assert worker is not None and worker._proc is not None, "worker never spawned"

    cancel = await bootstrapped_client.post(f"{base}/cancel-prompt")
    assert cancel.status_code == 200, cancel.text
    assert ApiResponse(**cancel.json()).data["cancelled"] is True

    # The turn task drains and deregisters the worker once the process dies.
    deadline = time.monotonic() + 10
    while pid in _PROMPT_WORKERS and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert pid not in _PROMPT_WORKERS, "cancelled turn never tore down"

    # Durable cancellation record (issue D09, claude side): the SIGTERM'd CLI
    # writes nothing durable itself, so the shared cancel path must persist a
    # flowpad-owned abort marker in the process record dir.
    proc = await AgenticProcess.get_by_id(pid)
    marker_file = turn_events_path(proc._record_dir())
    assert marker_file.exists(), "cancel-prompt must write a durable abort marker"
    markers = [json.loads(line) for line in marker_file.read_text().splitlines() if line.strip()]
    assert len(markers) == 1 and markers[0]["type"] == "turn_aborted"


# ── Issue D06: reload / client disconnect during a headless tool call ─────────

_CODEX_TID = "d06d06d0-aaaa-4000-8000-000000000006"
_CODEX_STREAM_TURN = [
    {"type": "thread.started", "thread_id": _CODEX_TID, "timestamp": "2026-07-10T06:00:00.000Z"},
    {
        "type": "item.completed",
        "timestamp": "2026-07-10T06:00:01.000Z",
        "item": {
            "type": "command_execution",
            "id": "call-d06",
            "command": "run-the-d06-tool",
            "aggregated_output": "TOOL-OUTPUT-D06",
            "exit_code": 0,
        },
    },
    {
        "type": "item.completed",
        "timestamp": "2026-07-10T06:00:02.000Z",
        "item": {"type": "agent_message", "id": "msg-d06", "text": "FINAL-ANSWER-D06"},
    },
    {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}, "timestamp": "2026-07-10T06:00:03.000Z"},
]


def _prompt_request_stub(message: str) -> MagicMock:
    """The established request-info seam (see test_agentic_process_switch_mode):
    supplies the JSON body ``_http_prompt`` reads via ``get_post_data``."""
    req = MagicMock()
    req.get_post_data = AsyncMock(return_value={"message": message})
    return req


@pytest.mark.asyncio
async def test_disconnect_mid_turn_shielded_turn_completes_durably(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """A hard reload (client disconnect) mid-tool-call must NOT cancel the
    headless turn (issue D06).

    Pre-fix, ``_stream_body``'s post-disconnect ``asyncio.wait_for(turn_task,
    1.0)`` CANCELLED the turn when the 1s grace lapsed — the worker was
    SIGTERM'd mid-tool and the durable transcript ended at the unmatched call.
    The ``asyncio.shield`` keeps the turn alive; this test fails (missing tool
    result / final answer) when the shield is removed.

    Transport note: httpx's ASGITransport buffers the whole app run, so a real
    mid-stream HTTP disconnect cannot be expressed through the test client.
    The disconnect is therefore driven at the exact seam starlette uses for a
    dropped client: ``StreamingResponse.body_iterator.aclose()`` after the
    first chunk. Everything else — entity, dispatch, worker subprocess,
    transcript tee, history endpoint — is the genuine stack.
    """
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        # 0.8s between lines: the disconnect lands right after the first chunk,
        # so the 1.0s grace expires while the tool result (t≈1.6s) and final
        # answer (t≈2.4s) are still pending — exactly the pre-fix kill window.
        fake_stream_argv(_CODEX_STREAM_TURN, delay_ms=800),
        env=dict(os.environ),
        stdin="",
    )

    pid = await create_agentic_process(
        bootstrapped_client, worker_type="codex", pty_mode=False, workdir=str(tmp_path)
    )
    proc = await AgenticProcess.get_by_id(pid)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        lambda: _prompt_request_stub("run the d06 tool"),
    )

    response = await proc._http_prompt()
    assert hasattr(response, "body_iterator"), f"expected StreamingResponse, got {response!r}"
    stream = response.body_iterator
    first_chunk = await stream.__anext__()
    assert first_chunk, "turn must start streaming before the disconnect"
    # Simulate the hard reload: starlette closes the response generator when
    # the client goes away.
    await stream.aclose()

    # The shielded turn keeps running detached; wait for its natural end.
    deadline = time.monotonic() + 10
    while pid in _PROMPT_WORKERS and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert pid not in _PROMPT_WORKERS, "disconnected turn never completed"

    got = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid}/get-history")
    history = ApiResponse(**got.json()).data["history"]
    tool_results = [fd for fd in history if "TOOL-OUTPUT-D06" in json.dumps(fd)]
    final_answers = [fd for fd in history if "FINAL-ANSWER-D06" in json.dumps(fd)]
    assert len(tool_results) == 1, f"tool result must be persisted exactly once, got {len(tool_results)}"
    assert len(final_answers) == 1, f"final answer must be persisted exactly once, got {len(final_answers)}"
    assert any(
        fd.get("attributes", {}).get("subtype") == "turn.completed" for fd in history
    ), "turn must have run to its durable turn.completed despite the disconnect"

    # Status settles: the entity is fetchable and the worker's session id stuck.
    entity = await get_agentic_process(bootstrapped_client, pid)
    assert entity["session_id"] == _CODEX_TID


# ── Issue D09: cancellation must leave a durable abort record ─────────────────


@pytest.mark.asyncio
async def test_cancel_prompt_abort_marker_replays_in_history(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """Stop on a headless codex turn writes a flowpad-owned abort marker that
    the history endpoint replays as a terminated-turn STATUS frame (issue D09).

    Pre-fix there was NO durable abort record anywhere: the SIGTERM'd codex CLI
    writes nothing, so after a hard reload the cancelled call replayed as still
    running. (The unmatched-call rendering itself is pinned in
    tests/unit/test_turn_abort_marker.py and the UI replay test.)
    """
    thread_started = json.dumps(
        # A timestamp like every real codex event — without one the replay
        # stamps parse-time "now", which would sort after the abort marker.
        {"type": "thread.started", "thread_id": _CODEX_TID, "timestamp": "2026-07-10T06:00:00.000Z"}
    )
    patch_build_spawn(
        monkeypatch,
        CodexCLIStreamWorker,
        # A long "real" command: announce the thread, then hang like a
        # long-running tool until cancel-prompt SIGTERMs us. ``exec`` so the
        # sleep replaces bash and the SIGTERM reaches the pipe holder (a forked
        # sleep would survive bash and keep stdout open for its full 30s).
        ["bash", "-c", f"printf '%s\\n' {json.dumps(thread_started)}; exec sleep 30"],
        env=dict(os.environ),
        stdin="",
    )

    pid = await create_agentic_process(
        bootstrapped_client, worker_type="codex", pty_mode=False, workdir=str(tmp_path)
    )
    base = f"/api/v1/graph/agentic_process/{pid}"
    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hang"})
    assert resp.status_code == 200, resp.text

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        worker = _PROMPT_WORKERS.get(pid)
        if worker is not None and getattr(worker, "_proc", None) is not None:
            break
        await asyncio.sleep(0.02)
    assert _PROMPT_WORKERS.get(pid) is not None, "worker never spawned"

    cancel = await bootstrapped_client.post(f"{base}/cancel-prompt")
    assert cancel.status_code == 200, cancel.text
    assert ApiResponse(**cancel.json()).data["cancelled"] is True

    deadline = time.monotonic() + 10
    while pid in _PROMPT_WORKERS and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert pid not in _PROMPT_WORKERS, "cancelled turn never tore down"

    # The durable marker exists on disk…
    proc = await AgenticProcess.get_by_id(pid)
    assert turn_events_path(proc._record_dir()).exists()

    # …and the history replay (what a reloaded UI renders from) carries exactly
    # one terminated-turn STATUS frame.
    got = await bootstrapped_client.get(f"{base}/get-history")
    history = ApiResponse(**got.json()).data["history"]
    terminated = [
        fd for fd in history if fd.get("attributes", {}).get("turn-terminated") == "true"
    ]
    assert len(terminated) == 1, f"expected exactly one abort marker in replay, got {len(terminated)}"
    assert terminated[0]["attributes"]["subtype"] == "turn_aborted"
    assert history.index(terminated[0]) == len(history) - 1, (
        "abort marker must replay after everything the dying turn flushed"
    )


@pytest.mark.asyncio
async def test_cancel_prompt_without_in_flight_turn_fails(bootstrapped_client, user, tmp_path):
    """``cancel-prompt`` with nothing running is a documented failure."""
    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{pid}/cancel-prompt"
    )
    res = ApiResponse(**resp.json())
    assert res.status == ApiResponseStatus.FAIL.value
    assert "in-flight" in (res.message or "").lower()


# ── R03: restart_required stays clear across transport switches + turns ──────


async def _restart_info(client, pid: str) -> dict:
    resp = await client.get(f"/api/v1/graph/agentic_process/{pid}/restart-info")
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


async def _wait_turn_done(pid: str) -> None:
    deadline = time.monotonic() + 20
    while pid in _PROMPT_WORKERS and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert pid not in _PROMPT_WORKERS, "headless turn never completed"


@pytest.mark.asyncio
async def test_r03_no_phantom_restart_across_transport_and_turns(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """QA R03 end-to-end: interactive → cli → headless turn → back to the
    interactive transport intent — ``restart_required`` stays False and
    ``restart-info.changed`` stays empty at EVERY settled point. Transport
    switches only move transport-derived launch fields; a turn's session
    rotation only moves session-derived fields; neither is config drift."""
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            _fake_stream_lines(
                [
                    {"type": "system", "subtype": "init"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": "ok"},
                ]
            )
        ),
        env=dict(os.environ),
    )

    pid = await create_agentic_process(
        bootstrapped_client, pty_mode=True, visible=True, workdir=str(tmp_path)
    )
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Settled point 1 — simulate a successful interactive start (the snapshot
    # capture start_pty performs, without spawning a real PTY).
    proc = await AgenticProcess.get_by_id(pid)
    proc.status = "running"
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.restart_required = False
    await proc.save()
    info = await _restart_info(bootstrapped_client, pid)
    assert info["restart_required"] is False and info["changed"] == [], info

    # Settled point 2 — switch to the CLI (headless) transport over HTTP.
    resp = await bootstrapped_client.post(f"{base}/switch-mode", json={"mode": "cli"})
    assert resp.status_code == 200, resp.text
    assert ApiResponse(**resp.json()).status == ApiResponseStatus.SUCCESS.value
    info = await _restart_info(bootstrapped_client, pid)
    assert info["restart_required"] is False, "transport switch must not glow restart"
    assert info["changed"] == [], info["changed"]

    # Settled point 3 — run a headless turn; the fake worker reports a session
    # id the process didn't have (the expected rotation on adopt/resume).
    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hi"})
    assert resp.status_code == 200, resp.text
    await _wait_turn_done(pid)
    entity = await get_agentic_process(bootstrapped_client, pid)
    assert entity["session_id"] == _FAKE_SID
    info = await _restart_info(bootstrapped_client, pid)
    assert info["restart_required"] is False and info["changed"] == [], info["changed"]
    assert entity["restart_required"] is False

    # Settled point 4 — flip the transport intent back to interactive. Even
    # BEFORE start_pty recaptures its snapshot, the intent flip alone must not
    # read as drift (transport-derived fields are excluded from comparators).
    proc = await AgenticProcess.get_by_id(pid)
    proc.pty_mode = True
    await proc.save()
    info = await _restart_info(bootstrapped_client, pid)
    assert info["restart_required"] is False and info["changed"] == [], info


@pytest.mark.asyncio
async def test_r03_session_rotation_does_not_clear_genuine_drift(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """A turn whose worker rotates the session id must NOT silently clear a
    restart_required caused by real config drift (model changed while the
    process is running). Guards the old full-payload re-capture behavior."""
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            _fake_stream_lines(
                [
                    {"type": "system", "subtype": "init"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": "ok"},
                ]
            )
        ),
        env=dict(os.environ),
    )

    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    # Baseline: as if launched with sonnet…
    proc = await AgenticProcess.get_by_id(pid)
    proc.cli_config = {"model": "claude-sonnet-4-6"}
    proc.status = "running"
    proc.last_started_snapshot = proc._restart_snapshot_payload()
    proc.last_started_hash = proc._restart_snapshot()
    proc.restart_required = False
    await proc.save()

    # …then the user switches the model: genuine drift.
    proc = await AgenticProcess.get_by_id(pid)
    proc.cli_config = {"model": "claude-opus-4-7"}
    await proc.save()
    info = await _restart_info(bootstrapped_client, pid)
    assert info["restart_required"] is True

    # A turn with the expected session rotation runs…
    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hi"})
    assert resp.status_code == 200, resp.text
    await _wait_turn_done(pid)

    # …and the drift is still flagged afterwards.
    entity = await get_agentic_process(bootstrapped_client, pid)
    assert entity["session_id"] == _FAKE_SID
    assert entity["restart_required"] is True, (
        "session adoption must not bless genuine config drift"
    )
    info = await _restart_info(bootstrapped_client, pid)
    fields = {(c["section"], c["field"]) for c in info["changed"]}
    assert ("worker", "model") in fields


@pytest.mark.asyncio
async def test_r03_spurious_mid_turn_rotation_ignored(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """Only the turn-INITIAL session report is adopted. A misbehaving extractor
    flapping ids mid-turn (simulated by patching ``get_session_id``) must not
    churn the persisted session id."""
    patch_build_spawn(
        monkeypatch,
        ClaudeCLIStreamWorker,
        fake_stream_argv(
            _fake_stream_lines(
                [
                    {"type": "system", "subtype": "init"},
                    {"type": "system", "subtype": "status"},
                    {"type": "result", "subtype": "success", "is_error": False, "result": "ok"},
                ]
            )
        ),
        env=dict(os.environ),
    )
    calls = {"n": 0}

    def flapping_get_session_id(self):
        calls["n"] += 1
        return "sid-first" if calls["n"] == 1 else f"sid-flap-{calls['n']}"

    monkeypatch.setattr(ClaudeCLIStreamWorker, "get_session_id", flapping_get_session_id)

    pid = await _create_headless_process(bootstrapped_client, str(tmp_path))
    base = f"/api/v1/graph/agentic_process/{pid}"

    resp = await bootstrapped_client.post(f"{base}/execute", json={"instruction": "hi"})
    assert resp.status_code == 200, resp.text
    await _wait_turn_done(pid)

    assert calls["n"] > 1, "guard not exercised: worker reported a sid only once"
    entity = await get_agentic_process(bootstrapped_client, pid)
    assert entity["session_id"] == "sid-first"
    assert entity["restart_required"] is False
