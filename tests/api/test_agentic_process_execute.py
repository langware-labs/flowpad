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
import shlex
import time

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


_FAKE_SID = "fake-session-id"


def _fake_stream_build_spawn(lines: list[dict]):
    """Return a ``_build_spawn`` stub emitting *lines* as stream-json then exit 0."""

    def _stub(self, prompt, context):  # noqa: ANN001 — matches the real signature
        pieces = []
        body = context.session_id or context.resume_session_id or _FAKE_SID
        for obj in lines:
            payload = dict(obj)
            payload.setdefault("session_id", body)
            pieces.append(f"printf '%s\\n' {shlex.quote(json.dumps(payload))}")
        script = "; ".join(pieces)
        return ["bash", "-c", script], dict(os.environ)

    return _stub


def _fake_hang_build_spawn(seconds: float = 30.0):
    """Return a ``_build_spawn`` stub whose subprocess just sleeps (in-flight turn)."""

    def _stub(self, prompt, context):  # noqa: ANN001
        return ["bash", "-c", f"sleep {seconds}"], dict(os.environ)

    return _stub


async def _create_headless_process(client, workdir: str) -> str:
    resp = await client.post(
        "/api/v1/graph/agentic_process",
        json={"worker_type": "claude_code", "pty_mode": False, "workdir": workdir},
    )
    assert resp.status_code == 200, resp.text
    data = ApiResponse(**resp.json()).data
    # pty_mode must persist as the transport intent (Rule 1).
    assert data["pty_mode"] is False, data
    return data["id"]


@pytest.mark.asyncio
async def test_execute_headless_round_trip_captures_session_id(
    bootstrapped_client, user, tmp_path, monkeypatch
):
    """``execute`` on a headless process runs a print-mode turn and persists the
    session id the worker reported."""
    monkeypatch.setattr(
        ClaudeCLIStreamWorker,
        "_build_spawn",
        _fake_stream_build_spawn(
            [
                {"type": "system", "subtype": "init"},
                {"type": "result", "subtype": "success", "is_error": False, "result": "ok"},
            ]
        ),
        raising=True,
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
    monkeypatch.setattr(
        ClaudeCLIStreamWorker,
        "_build_spawn",
        _fake_stream_build_spawn(
            [
                {"type": "system", "subtype": "init"},
                {"type": "result", "subtype": "success", "is_error": False, "result": "done"},
            ]
        ),
        raising=True,
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
    monkeypatch.setattr(
        ClaudeCLIStreamWorker, "_build_spawn", _fake_hang_build_spawn(30.0), raising=True
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
