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

HUB_URL = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:9008")


@pytest.fixture
async def hub_and_node():
    """Yields (httpx.AsyncClient, compute_node_id). Skips if hub isn't reachable."""
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


async def test_prompt_rejects_visible_process(hub_and_node, tmp_path):
    """visible=true processes must not be admitted to the prompt action."""
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

    r2 = await hub_client.post(
        f"/api/v1/graph/agentic_process/{pid}/prompt",
        json={"message": "hi"},
    )
    assert r2.status_code != 200, f"prompt unexpectedly admitted visible=true: {r2.text[:200]}"
