"""Tests for the session-transcript endpoint on ComputeNode."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from httpx import AsyncClient

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.instance_settings import get_instance_settings


@pytest.mark.asyncio
async def test_session_transcript_requires_session_id(bootstrapped_client: AsyncClient):
    """Missing session_id returns FAIL."""
    resp = await bootstrapped_client.get("/api/v1/graph/compute_node/@local/session-transcript")
    body = resp.json()
    assert body["status"] == "FAIL"
    assert "session_id" in body["message"]


@pytest.mark.asyncio
async def test_session_transcript_nonexistent_returns_empty(bootstrapped_client: AsyncClient):
    """Nonexistent session_id returns OK with empty data list."""
    resp = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/session-transcript",
        params={"session_id": "nonexistent-session-id"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["data"] == []


@pytest.mark.asyncio
async def test_session_transcript_excludes_raw_json(bootstrapped_client: AsyncClient):
    """A populated transcript retains its entry fields and excludes raw_json."""
    session_id = mint_uuid()
    entry_id = mint_uuid()
    timestamp = "2026-05-07T00:00:00.000Z"
    message = {"role": "user", "content": "Transcript response fixture"}
    raw = {
        "type": "user",
        "sessionId": session_id,
        "uuid": entry_id,
        "timestamp": timestamp,
        "message": message,
        "raw_json": {"fixture": "must be excluded"},
    }
    projects_dir = get_instance_settings().claude_projects_dir
    projects_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="e2etest-transcript-", dir=projects_dir) as folder:
        raw["cwd"] = folder
        jsonl_file = Path(folder) / f"{session_id}.jsonl"
        jsonl_file.write_text(json.dumps(raw) + "\n", encoding="utf-8")
        resp = await bootstrapped_client.get(
            "/api/v1/graph/compute_node/@local/session-transcript",
            params={"session_id": session_id},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert len(body["data"]) == 1
    entry = body["data"][0]
    assert "raw_json" not in entry, "raw_json should be excluded by default"
    assert entry["entry_type"] == "user"
    assert entry["entry_uuid"] == entry_id
    assert entry["timestamp"] == timestamp
    assert entry["message"] == message
