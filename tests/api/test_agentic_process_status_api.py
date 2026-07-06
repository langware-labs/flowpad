"""API tests for the consolidated status model on AgenticProcess.

Verifies the wire contract after the ProcessStatus/WorkerStatus consolidation:
- ``/status`` action returns ``{status, worker_status, ready_for_input, …}``
  with the new lifecycle wire values (``running`` not ``live``).
- The legacy ghost fields ``is_active`` and ``waiting_for_prompt`` are absent
  from both the status action response and the GET /<id> entity payload.
- ``target_typeid_str`` round-trips through entity creation + query-filter lookup.
"""

from __future__ import annotations

import uuid
from urllib.parse import quote

import pytest

from flow_sdk.builtin.agentic_process import (
    AgenticProcess,
    ProcessStatus,
    WorkerStatus,
)
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


# ---------------------------------------------------------------------------
# /status action shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_action_returns_new_shape(bootstrapped_client, user):
    """/status returns {status, worker_status, ready_for_input}; ghost fields absent."""
    client = bootstrapped_client

    process = AgenticProcess(name="status-shape-test")
    await process.save(user.typeid)

    try:
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        res = ApiResponse(**body)
        assert res.status == ApiResponseStatus.SUCCESS.value

        data = res.data
        assert isinstance(data, dict), data

        # New canonical fields
        assert "status" in data
        assert "worker_status" in data
        assert "ready_for_input" in data
        assert isinstance(data["ready_for_input"], bool)

        # Ghost fields must be absent
        assert "is_active" not in data
        assert "waiting_for_prompt" not in data

        # Default lifecycle is NEW (not projected); worker_status is null (no
        # session/transcript → "nothing found", never coerced to a placeholder).
        assert data["status"] == ProcessStatus.NEW.value
        assert data["worker_status"] is None
        # NEW lifecycle can never be ready_for_input (only READY is).
        assert data["ready_for_input"] is False
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_get_entity_omits_ghost_fields(bootstrapped_client, user):
    """GET /agentic_process/<id> entity payload must not include is_active/waiting_for_prompt."""
    client = bootstrapped_client

    process = AgenticProcess(name="ghost-fields-test")
    await process.save(user.typeid)

    try:
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        data = body.get("data")
        assert isinstance(data, dict), body

        assert "is_active" not in data
        assert "waiting_for_prompt" not in data
        # But worker_status + ready_for_input (derived projections) should be present.
        assert "worker_status" in data
        assert "ready_for_input" in data
    finally:
        await process.delete()


# ---------------------------------------------------------------------------
# Lifecycle transitions visible via /status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_reflects_lifecycle_writes(bootstrapped_client, user):
    """Setting status directly on the entity surfaces in the next /status GET."""
    client = bootstrapped_client

    process = AgenticProcess(name="lifecycle-transitions")
    await process.save(user.typeid)

    try:
        # NEW (default)
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        data = ApiResponse(**resp.json()).data
        assert data["status"] == ProcessStatus.NEW.value
        assert data["ready_for_input"] is False

        # STARTING
        process.status = ProcessStatus.STARTING.value
        await process.save()
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        data = ApiResponse(**resp.json()).data
        assert data["status"] == ProcessStatus.STARTING.value
        assert data["ready_for_input"] is False

        # RUNNING — still no session_id, so worker has never been prompted and no
        # turn is in flight → status is the raw ``running`` (emitted verbatim),
        # ``busy`` is False, and ``ready_for_input`` is True.
        process.status = ProcessStatus.RUNNING.value
        await process.save()
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        data = ApiResponse(**resp.json()).data
        assert data["status"] == ProcessStatus.RUNNING.value
        assert data["busy"] is False
        assert data["ready_for_input"] is True

        # STOPPED (terminal) — not ready any more.
        process.status = ProcessStatus.STOPPED.value
        await process.save()
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        data = ApiResponse(**resp.json()).data
        assert data["status"] == ProcessStatus.STOPPED.value
        assert data["ready_for_input"] is False

        # FAILED
        process.status = ProcessStatus.FAILED.value
        await process.save()
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}/status")
        data = ApiResponse(**resp.json()).data
        assert data["status"] == ProcessStatus.FAILED.value
        assert data["ready_for_input"] is False
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_status_no_live_wire_value(bootstrapped_client, user):
    """The old ``live`` wire value must no longer be reachable via enum."""
    # Enum regression — writing the old string manually still stores it (it's a plain
    # str), but the enum has no LIVE member.
    with pytest.raises(AttributeError):
        _ = ProcessStatus.LIVE  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# target_typeid_str round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_target_typeid_str_round_trip(bootstrapped_client, user):
    """Create with target_typeid_str, look up by filter, get it back."""
    client = bootstrapped_client

    target = f"trigger-{uuid.uuid4()}"
    process = AgenticProcess(
        name="target-round-trip",
        target_typeid_str=target,
    )
    await process.save(user.typeid)

    try:
        # Direct fetch: the field is on the payload.
        resp = await client.get(f"/api/v1/graph/agentic_process/{process.id}")
        assert resp.status_code == 200, resp.text
        data = resp.json().get("data")
        assert data.get("target_typeid_str") == target

        # Query filter: match on target_typeid_str must return our process.
        url = (
            "/api/v1/graph/agentic_process"
            "?filter%5Bmatch%5D%5Bop%5D=%24EQ"
            "&filter%5Bmatch%5D%5Boperands%5D%5B0%5D=target_typeid_str"
            f"&filter%5Bmatch%5D%5Boperands%5D%5B1%5D={quote(target, safe='')}"
        )
        resp = await client.get(url)
        assert resp.status_code == 200, resp.text
        rows = resp.json().get("data") or []
        ids = {row.get("id") for row in rows}
        assert process.id in ids
    finally:
        await process.delete()
