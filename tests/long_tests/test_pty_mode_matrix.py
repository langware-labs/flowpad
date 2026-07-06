"""Both-transport matrix for the ``pty_mode`` flag — every vendor, both modes.

The `pty_mode` flag selects the transport an AgenticProcess runs with WITHOUT
changing its interface: ``pty_mode=true`` → interactive PTY (``visible=true``),
``pty_mode=false`` → headless JSON-stream (``visible=false``). Routing stays
``headless == !visible``. A caller does the SAME thing in both modes — create,
``prompt``, read flow frames — so the SAME assertion must hold for both.

This is a NEW test (no existing test is edited); existing tests keep running in
PTY via the ``pty_mode`` default of true. Drives the running hub (same as
``test_agentic_process_prompt_streaming``) so it exercises the real CLIs.

Gated on ``DEEP_TESTING=true``; skips if the hub is unreachable or a vendor's
CLI binary isn't installed. Point at a dedicated instance to avoid the main
backend:

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6007 \
        uv run pytest tests/long_tests/test_pty_mode_matrix.py -v -s
"""

from __future__ import annotations

import asyncio
import os
import shutil

import httpx
import pytest

from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

# No hardcoded default: a long/e2e test must NEVER silently target the main
# dev backend (its loaded DB makes createProcess pathologically slow and the
# port is environment-specific). Require an explicit dedicated-instance URL;
# the fixture skips with a clear message when it is unset.
HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

# worker_type → CLI binary that must be on PATH for that vendor's rows to run.
_VENDOR_BINARY = {
    "claude_code": "claude",
    "codex": "codex",
    "copilot": "copilot",
}

_TRIVIAL_PROMPT = 'Respond with exactly the single word "pong" and nothing else.'


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=25.0))
    try:
        try:
            r = await client.get("/api/v1/graph/bootstrap", params={"domain": "localhost"})
        except httpx.ConnectError:
            await client.aclose()
            pytest.skip(f"hub not reachable at {HUB_URL}")
        if r.status_code != 200:
            await client.aclose()
            pytest.skip(f"hub bootstrap {r.status_code}")
        data = r.json().get("data") or {}
        node = data.get("default_compute_node") or {}
        cnid = node.get("id")
        if not cnid:
            await client.aclose()
            pytest.skip("no default compute node in bootstrap")
        yield client, cnid
    finally:
        await client.aclose()


def _require_binary(worker_type: str) -> None:
    binary = _VENDOR_BINARY[worker_type]
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} CLI not installed — skipping {worker_type} rows")


async def _create(hub_client, compute_node_id: str, workdir: str, worker_type: str, pty_mode: bool) -> dict:
    """Create a process in the requested transport. Returns the process row."""
    body = {
        "context": {
            "workdir": workdir,
            "worker_type": worker_type,
            "permission_mode": "bypassPermissions",
        },
        # headless == !visible; pty_mode seeds visible at launch (see plan).
        "visible": pty_mode,
        "pty_mode": pty_mode,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:400]}"
    pid = (r.json().get("data") or r.json())["id"]
    # createProcess returns a minimal row (id/type/shell_id/pty_pid); GET the
    # entity to read the persisted fields (pty_mode, visible, session_id).
    g = await hub_client.get(f"/api/v1/graph/agentic_process/{pid}")
    assert g.status_code == 200, f"get process {g.status_code}: {g.text[:300]}"
    return g.json().get("data") or g.json()


async def _prompt_until_flow(hub_client, process_id: str, message: str) -> str:
    """Send a prompt; return the streamed body once a flow-* frame is seen.

    Breaks early — fast, for the single-turn "a frame arrives" assertion.
    """
    received = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": message},
    ) as r:
        assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
        async for chunk in r.aiter_bytes():
            received += chunk
            if b"<flow-" in received:
                break
    return received.decode("utf-8", errors="replace")


async def _send_turn(hub_client, process_id: str, message: str) -> str:
    """Transport-agnostic single turn: read until the first flow-* frame, then stop.

    Retries on the 409 "another prompt turn is already in flight" — the PRIOR
    turn is still running (a PTY stream never closes, so we can't drain it; we
    break early and just wait for the worker to free up). A 409 that is NOT an
    in-flight race (e.g. ``status=failed``) is a real error and re-raised.
    Bounded so a wedged turn fails the test rather than hanging past the cap.
    """
    deadline_attempts = 20
    for _ in range(deadline_attempts):
        received = b""
        async with hub_client.stream(
            "POST",
            f"/api/v1/graph/agentic_process/{process_id}/prompt",
            json={"message": message},
        ) as r:
            if r.status_code == 409:
                txt = (await r.aread()).decode()
                if "already in flight" in txt:
                    await asyncio.sleep(1.0)
                    continue
                raise AssertionError(f"prompt 409 (not an in-flight race): {txt[:200]}")
            assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:300]}"
            async for chunk in r.aiter_bytes():
                received += chunk
                if b"<flow-" in received:
                    return received.decode("utf-8", errors="replace")
        # Stream closed with no flow frame — let the worker settle and retry.
        await asyncio.sleep(1.0)
    raise AssertionError(f"no flow frame after {deadline_attempts} attempts on {process_id}")


async def _settle_session_id(hub_client, process_id: str) -> str | None:
    """Poll the process row until a session_id is persisted (or give up)."""
    for _ in range(15):
        r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}")
        sid = (r.json().get("data") or r.json()).get("session_id")
        if sid:
            return sid
        await asyncio.sleep(1.0)
    return None


@pytest.mark.parametrize("worker_type", ["claude_code", "codex", "copilot"])
@pytest.mark.parametrize("pty_mode", [True, False], ids=["pty", "headless"])
async def test_prompt_streams_in_both_transports(hub_and_node, tmp_path, worker_type, pty_mode):
    """The SAME create→prompt→flow-frame flow works in PTY and headless, per vendor.

    Mode-agnostic assertion (flow-* frames, not terminal bytes) so it holds for
    both transports — the whole point of `pty_mode` keeping the interface identical.
    """
    _require_binary(worker_type)
    hub_client, cnid = hub_and_node

    proc = await _create(hub_client, cnid, str(tmp_path), worker_type, pty_mode)
    pid = proc["id"]
    # The persisted transport intent must reflect the request.
    assert proc.get("pty_mode", True) is pty_mode, f"pty_mode not persisted: {proc.get('pty_mode')}"

    xml = await _prompt_until_flow(hub_client, pid, _TRIVIAL_PROMPT)
    assert "<flow-" in xml, f"{worker_type}/{'pty' if pty_mode else 'headless'}: no flow frame: {xml[:300]}"


@pytest.mark.parametrize("worker_type", ["claude_code", "codex", "copilot"])
@pytest.mark.parametrize("pty_mode", [True, False], ids=["pty", "headless"])
async def test_multi_turn_resumes_same_session(hub_and_node, tmp_path, worker_type, pty_mode):
    """Two turns on one process stream in both modes, and the session_id is stable.

    This is where headless resume can regress (e.g. a vendor whose resume gate
    only checks the global rollout dir, not the per-process headless transcript):
    turn 2 would start fresh and split history.
    """
    _require_binary(worker_type)
    hub_client, cnid = hub_and_node

    proc = await _create(hub_client, cnid, str(tmp_path), worker_type, pty_mode)
    pid = proc["id"]

    xml1 = await _send_turn(hub_client, pid, _TRIVIAL_PROMPT)
    assert "<flow-" in xml1, f"turn1 no flow frame: {xml1[:200]}"

    sid1 = await _settle_session_id(hub_client, pid)
    assert sid1, "turn 1 did not establish a session_id"

    # _send_turn retries on the in-flight 409 until turn 1 frees the worker.
    xml2 = await _send_turn(hub_client, pid, "Say pong again.")
    assert "<flow-" in xml2, f"turn2 no flow frame: {xml2[:200]}"

    sid2 = await _settle_session_id(hub_client, pid)
    assert sid2 == sid1, (
        f"{worker_type}/{'pty' if pty_mode else 'headless'}: session_id changed across turns "
        f"({sid1} → {sid2}) — turn 2 started a fresh session instead of resuming"
    )
