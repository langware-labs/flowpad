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
import os
import time

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
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
