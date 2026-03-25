"""Tests for the scope + project_ids filtering in the search endpoint."""

import pytest


@pytest.mark.asyncio
async def test_search_scope_user(bootstrapped_client):
    """scope=user should filter to user-scoped entities only."""
    resp = await bootstrapped_client.get("/api/v1/search?record_type=skill&scope=user&limit=50")
    assert resp.status_code == 200
    data = resp.json()["data"]
    for r in data["results"]:
        assert r["scope"] == "user"


@pytest.mark.asyncio
async def test_search_scope_project_with_ids(bootstrapped_client):
    """scope=project&project_ids=X should filter to project-scoped entities matching IDs."""
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=skill&scope=project&project_ids=test-project-1&limit=50"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    for r in data["results"]:
        assert r["scope"] == "project"
