"""Tests for the unified ScopeFilter on the search endpoint.

Wire format: `?user=true&projects=A,B`. Absent params → no filter applied
(legacy compat for any caller that hasn't migrated yet).
"""

import pytest


@pytest.mark.asyncio
async def test_search_user_only(bootstrapped_client):
    """user=true & projects= → keep user-scoped rows; drop project-scoped rows.

    Unscoped record types (like ``project`` itself) are not in the skill type,
    so for ``record_type=skill`` every returned row should be scope='user'.
    """
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=skill&user=true&projects=&limit=50"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    for r in data["results"]:
        assert r["scope"] == "user"


@pytest.mark.asyncio
async def test_search_project_with_ids(bootstrapped_client):
    """user=false & projects=X → only project-scoped rows whose project_id is X.

    With ``user=false`` and the listed project_ids, no user-scoped rows should
    appear; every project-scoped row must have project_id in the list. There
    may be zero rows if no skill exists in 'test-project-1' — that's fine.
    """
    resp = await bootstrapped_client.get(
        "/api/v1/search?record_type=skill&user=false&projects=test-project-1&limit=50"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    for r in data["results"]:
        assert r["scope"] == "project"
        assert r.get("project_id") == "test-project-1"


@pytest.mark.asyncio
async def test_search_no_filter_when_params_absent(bootstrapped_client):
    """Omitting both params disables the scope filter — back-compat for any
    legacy caller. The response should be a superset of any user/project query."""
    full = await bootstrapped_client.get("/api/v1/search?record_type=skill&limit=50")
    assert full.status_code == 200
    user_only = await bootstrapped_client.get(
        "/api/v1/search?record_type=skill&user=true&projects=&limit=50"
    )
    assert user_only.status_code == 200
    assert full.json()["data"]["total"] >= user_only.json()["data"]["total"]
