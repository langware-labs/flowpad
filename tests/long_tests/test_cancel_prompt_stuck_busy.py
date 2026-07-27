"""Long E2E test: cancelling an in-flight headless prompt turn must clear ``busy``.

Bug (RCA 2026-07-07, vibe "can't stop the conversation"): ``cancel-prompt``
really kills the print-mode CLI (SIGTERM→SIGKILL), but the killed CLI never
writes its terminal transcript entry, so ``fetch_worker_status`` keeps deriving
a mid-turn ``working`` from the JSONL tail. ``is_turn_busy`` counts that raw
worker status as busy regardless of transport, and CLI mode has no liveness
reconciliation (unlike PTY's ``pty_recovery``) — so the process reports
``busy: true`` forever. The UI keeps the Stop square up with the composer
locked, and a second Stop click fails with "no in-flight prompt turn".

This test drives the REAL mechanism end-to-end against a dedicated running
instance: a real ``claude -p`` turn, a real ``cancel-prompt`` kill mid-turn,
then asserts the serialized ``busy`` boolean clears. Today it fails exactly
the way the bug manifests: busy stays ``True`` after a successful cancel.

Gated like the sibling prompt-streaming test:
  - ``DEEP_TESTING=true`` (requires Claude CLI + network)
  - ``FLOWPAD_HUB_URL`` pointing at a DEDICATED instance
    (``scripts/instance_ctl.sh launch <name>``), never the main dev backend.

Run:

    DEEP_TESTING=true FLOWPAD_HUB_URL=http://localhost:6002 \
        uv run pytest tests/long_tests/test_cancel_prompt_stuck_busy.py -v -s
"""

from __future__ import annotations

import asyncio
import os
import time

import httpx
import pytest

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

HUB_URL = os.environ.get("FLOWPAD_HUB_URL")

# A task long enough that the turn is reliably still mid-flight when the
# cancel lands (multiple Write tool calls), mirroring the vibe repro prompt.
LONG_TASK = (
    "Build a multi-page website about mountain hiking with 6 separate HTML "
    "pages, a shared CSS file, and a JS photo carousel. Write every file "
    "fully, one at a time."
)


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
    if not HUB_URL:
        pytest.skip(
            "FLOWPAD_HUB_URL not set — point this e2e test at a DEDICATED instance "
            "(scripts/instance_ctl.sh launch <name>), never the main dev backend."
        )
    client = httpx.AsyncClient(base_url=HUB_URL, timeout=httpx.Timeout(10.0, read=120.0))
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


async def _create_print_mode_process(hub_client, compute_node_id: str, workdir: str) -> str:
    body = {
        "context": {
            "workdir": workdir,
            "output_format": "stream-json",
            "permission_mode": "bypassPermissions",
            "model": ModelTier.SM.value,
        },
        "visible": False,
        # Headless print-mode transport — the vibe chat's exact configuration
        # (`useStartVibeSession` passes pty_mode=False).
        "pty_mode": False,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:500]}"
    payload = r.json()
    proc = payload.get("data") or payload
    pid = proc.get("id")
    assert pid, f"no process id in payload: {payload}"
    return pid


async def _get_busy(hub_client, process_id: str) -> tuple[bool | None, str | None]:
    """(busy, worker_status) from the serialized entity — the wire truth the UI gates on."""
    r = await hub_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert r.status_code == 200, f"GET process {r.status_code}: {r.text[:300]}"
    e = r.json().get("data") or {}
    return e.get("busy"), e.get("worker_status")


async def test_cancel_prompt_clears_busy(hub_and_node, tmp_path):
    """Cancel a real in-flight print-mode turn; ``busy`` must go False.

    Fails today: cancel-prompt returns ``{"cancelled": true}`` (the CLI is
    really killed) but the entity keeps serializing ``busy: true`` /
    ``worker_status: "working"`` off the dead turn's transcript tail.
    """
    hub_client, compute_node_id = hub_and_node
    process_id = await _create_print_mode_process(hub_client, compute_node_id, str(tmp_path))

    # Fire the turn and keep the stream open in the background — the vibe UI
    # holds the prompt stream for the whole turn; the cancel must land while
    # the worker is genuinely mid-flight.
    async def _consume_stream() -> None:
        async with hub_client.stream(
            "POST",
            f"/api/v1/graph/agentic_process/{process_id}/prompt",
            json={"message": LONG_TASK},
        ) as r:
            assert r.status_code == 200, f"prompt {r.status_code}"
            async for _ in r.aiter_bytes():
                pass

    stream_task = asyncio.create_task(_consume_stream())

    try:
        # Wait for the turn to be genuinely mid-work before cancelling: the
        # worker must have written mid-turn transcript entries (raw
        # worker_status in the busy set), because the bug is the killed CLI's
        # dangling mid-turn TAIL. Cancelling in the pre-transcript boot window
        # leaves no tail and (correctly) clears busy — that path is not the bug.
        # Budgets fit inside the suite-wide 30s pytest-timeout cap:
        # ≤20s to reach mid-turn + cancel, ≤8s for busy to clear. A stuck busy
        # never clears (that's the bug), so 8s is ample to prove non-clearing.
        _MID_TURN = {"working", "thinking", "tool_call", "tool_running"}
        deadline = time.monotonic() + 20.0
        cancelled = False
        while time.monotonic() < deadline and not cancelled:
            busy, worker_status = await _get_busy(hub_client, process_id)
            if busy and worker_status in _MID_TURN:
                r = await hub_client.post(
                    f"/api/v1/graph/agentic_process/{process_id}/cancel-prompt",
                    json={},
                )
                payload = r.json()
                if payload.get("status") == "SUCCESS" and (payload.get("data") or {}).get("cancelled"):
                    cancelled = True
                    break
            await asyncio.sleep(0.3)
        assert cancelled, (
            "never managed to cancel a mid-work turn (worker never reached a "
            "mid-turn worker_status, or the turn finished first)"
        )

        # The bug's manifestation: after a SUCCESSFUL cancel the wire busy flag
        # must clear so the UI can flip Stop→Send and unlock the composer.
        # Poll the serialized entity — no UI heuristics.
        clear_deadline = time.monotonic() + 8.0
        busy, worker_status = await _get_busy(hub_client, process_id)
        while time.monotonic() < clear_deadline and busy:
            await asyncio.sleep(0.5)
            busy, worker_status = await _get_busy(hub_client, process_id)
        assert busy is not True, (
            "busy stuck True after a successful cancel-prompt "
            f"(worker_status={worker_status!r}) — the killed CLI's transcript tail "
            "keeps the process busy forever; the UI can never stop the conversation"
        )
    finally:
        stream_task.cancel()
        try:
            await stream_task
        except (asyncio.CancelledError, Exception):
            pass
