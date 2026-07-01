"""Long-running E2E test for ``AgenticProcess.prompt`` — hits the running hub.

Rather than bootstrap an in-process ASGI test client (the bootstrap path scans
filesystem for markdown records which hangs on transient paths under
``/private/tmp/claude-501/…``), this test drives the **already-running hub on
localhost:9008** — the same hub the UI uses. That's also what the user sees,
so it's the most realistic validation.

Gated on:
  - ``DEEP_TESTING=true`` env var (requires Claude CLI + network)
  - ``FLOWPAD_HUB_URL`` env var (defaults to ``http://localhost:9008``). If the
    hub isn't reachable, the test skips rather than fails.

Run:

    DEEP_TESTING=true uv run pytest tests/long_tests/test_agentic_process_prompt_streaming.py -v -s
"""

from __future__ import annotations

import os
import re

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
        },
        "visible": False,
        # pty_mode is the durable transport selector (defaults to True since the
        # commit-624ddb89 routing refactor decoupled transport from `visible`).
        # Print-mode streaming (the flow-status/flow-chat/flow-end worker frames
        # this test asserts) is reached only when pty_mode is False; visible=False
        # alone now yields the PTY transcript-entry stream.
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


async def test_prompt_streams_xml_flowdata_for_trivial_turn(hub_and_node, tmp_path):
    """Send a one-word prompt, assert flow-status + flow-chat + flow-end arrive."""
    hub_client, local_compute_node_id = hub_and_node
    process_id = await _create_print_mode_process(hub_client, local_compute_node_id, str(tmp_path))

    body = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{process_id}/prompt",
        json={"message": 'Respond with exactly the single word "pong" and nothing else.'},
    ) as r:
        assert r.status_code == 200, f"prompt {r.status_code}: {(await r.aread()).decode()[:400]}"
        async for chunk in r.aiter_bytes():
            body += chunk

    xml = body.decode("utf-8", errors="replace")
    assert "<flow-status" in xml, f"no status frame: {xml[:400]}"
    assert "<flow-chat" in xml, f"no chat frame: {xml[:400]}"
    assert "<flow-end" in xml, f"no end frame: {xml[:400]}"

    close_tags = re.findall(r"</flow-[a-z-]+>", xml)
    assert close_tags, "no flow-* closing tags"
    assert close_tags[-1] == "</flow-end>", f"stream did not close with flow-end: last={close_tags[-1]}"


async def test_prompt_admits_visible_process_via_pty_transport(hub_and_node, tmp_path):
    """visible=true (PTY) processes are admitted to the unified prompt action.

    The prompt action is a single endpoint with two transports keyed off
    ``visible`` (the tabs/chat unification): ``visible=False`` streams a
    print-mode worker's stdout, ``visible=True`` streams the PTY session
    transcript (``_run_pty_prompt``). Both return a 200 streaming response —
    the older "PTY processes reject with 409" contract no longer holds.
    """
    hub_client, local_compute_node_id = hub_and_node
    body = {
        "context": {"workdir": str(tmp_path), "permission_mode": "bypassPermissions"},
        "visible": True,
    }
    r = await hub_client.post(
        f"/api/v1/graph/compute_node/{local_compute_node_id}/createProcess",
        json=body,
    )
    assert r.status_code == 200
    pid = (r.json().get("data") or r.json())["id"]

    received = b""
    async with hub_client.stream(
        "POST",
        f"/api/v1/graph/agentic_process/{pid}/prompt",
        json={"message": 'Respond with exactly the single word "pong" and nothing else.'},
    ) as r2:
        assert r2.status_code == 200, (
            f"visible=true prompt not admitted: {r2.status_code}: {(await r2.aread()).decode()[:200]}"
        )
        async for chunk in r2.aiter_bytes():
            received += chunk
            if b"<flow-" in received:
                break

    assert b"<flow-" in received, f"no flow-* frame from PTY transport: {received.decode('utf-8', 'replace')[:300]}"
