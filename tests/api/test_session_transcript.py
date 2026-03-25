"""Tests for the session-transcript endpoint on ComputeNode."""

import pytest
from httpx import AsyncClient


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
    """If entries exist, raw_json field should NOT appear in response."""
    # This test requires a real session JSONL to exist.
    # In CI without real sessions, the endpoint returns [] which is still valid.
    # When run locally with real Claude sessions, it validates raw_json exclusion.
    import pathlib

    projects_dir = pathlib.Path.home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        pytest.skip("No ~/.claude/projects directory")

    # Find any existing session
    session_id = None
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for jsonl_file in project_dir.glob("*.jsonl"):
            session_id = jsonl_file.stem
            break
        if session_id:
            break

    if not session_id:
        pytest.skip("No Claude sessions found")

    resp = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/session-transcript",
        params={"session_id": session_id},
    )
    body = resp.json()
    assert body["status"] == "SUCCESS"
    if body["data"]:
        for entry in body["data"]:
            assert "raw_json" not in entry, "raw_json should be excluded by default"
            assert "entry_type" in entry
            assert "entry_uuid" in entry or "id" in entry
            assert "timestamp" in entry
