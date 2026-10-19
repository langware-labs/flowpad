"""Integration: framed PTY stream — spawn → output → resize → GET endpoint.

Drives the real HTTP paths (no mocks, no provider-direct calls): a PTY is
opened through the agentic-process open action, resized through the
terminal-command API, and the framed stream is fetched through the new
``GET /api/v1/shell/{shell_id}/pty-stream`` endpoint.
"""

import asyncio
import base64

import pytest

from flow_sdk.responses.response import ApiResponse
pytestmark = pytest.mark.usefixtures("usable_claude_source")


def _default_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


async def _open_pty(client, instruction: str | None) -> tuple[str, str]:
    """Create a process and open a PTY; returns (compute_node_id, shell_id)."""
    bootstrap = await client.get("/api/v1/graph/bootstrap")
    assert bootstrap.status_code == 200
    compute_node_id = _default_compute_node_id(bootstrap.json())

    response = await client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json={"context": {"compute_node_id": f"compute_node-{compute_node_id}"}, "visible": True},
    )
    assert response.status_code == 200, response.text
    process_id = ApiResponse(**response.json()).data["id"]

    body = {} if instruction is None else {"instruction": instruction}
    response = await client.post(f"/api/v1/graph/agentic_process/{process_id}/open", json=body)
    assert response.status_code == 200, response.text
    result = ApiResponse(**response.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"
    return compute_node_id, result.data["shell_id"]


async def _wait_for_output(client, shell_id: str, min_total: int) -> dict:
    """Poll the stream endpoint until min_total output bytes are recorded."""
    deadline = asyncio.get_event_loop().time() + 15  # do not increase timeout without approval
    last = None
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"/api/v1/shell/{shell_id}/pty-stream")
        if r.status_code == 200:
            last = r.json()["data"]
            total = sum(len(base64.b64decode(e[1])) for e in last["events"] if e[0] == "o")
            if total >= min_total:
                return last
        await asyncio.sleep(0.2)
    raise AssertionError(f"stream never reached {min_total} output bytes; last header: "
                         f"{ {k: last.get(k) for k in ('v', 'cols', 'rows')} if last else None }")


@pytest.mark.asyncio
async def test_pty_stream_records_output_and_resize(bootstrapped_client):
    client = bootstrapped_client
    compute_node_id, shell_id = await _open_pty(client, None)

    # The spawned program (claude TUI onboarding or plain shell) paints the
    # screen — wait until a substantial amount of output is recorded.
    stream = await _wait_for_output(client, shell_id, min_total=1000)

    # Header: framed v1 with a real initial size
    assert stream["v"] == 1
    assert isinstance(stream["cols"], int) and stream["cols"] > 0
    assert isinstance(stream["rows"], int) and stream["rows"] > 0

    n_events_before = len(stream["events"])

    # Resize through the real terminal-command API → a resize frame is recorded
    r = await client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/terminal-command/resize",
        json={"shell_id": shell_id, "cols": 77, "rows": 21},
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/api/v1/shell/{shell_id}/pty-stream")
    assert r.status_code == 200
    events = r.json()["data"]["events"]
    resize_indices = [i for i, e in enumerate(events) if e == ["r", [77, 21]]]
    assert resize_indices, f"resize frame missing: {[e for e in events if e[0] == 'r']}"
    # Appended in stream order: after everything that was recorded pre-resize
    assert resize_indices[0] >= n_events_before

    # A second identical resize is skipped by the same-size guard — no new frame
    r = await client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/terminal-command/resize",
        json={"shell_id": shell_id, "cols": 77, "rows": 21},
    )
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/v1/shell/{shell_id}/pty-stream")
    assert len([e for e in r.json()["data"]["events"] if e == ["r", [77, 21]]]) == 1


@pytest.mark.asyncio
async def test_pty_stream_404s(bootstrapped_client):
    r = await bootstrapped_client.get("/api/v1/shell/no-such-shell/pty-stream")
    assert r.status_code == 404
