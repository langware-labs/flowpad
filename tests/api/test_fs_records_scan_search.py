"""API-level validation tests for fs-records scan, index, and search endpoints.

Covers:
  GET  /fs-records/scan              → aggregate stats (all registered types)
  GET  /fs-records/scan?type=X       → per-type stats + record list
  POST /fs-records/index             → index all types
  POST /fs-records/index?type=X      → index one type
  GET  /fs-records/search?q=...      → semantic search (NoOpIndexer: always empty)
  GET  /fs-records/search?record_type=X   → filter-only browse (new behaviour)
  GET  /fs-records/search?q=...&record_type=X  → combo query + filter
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root

# Trigger type auto-registration
from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401
from flow_sdk.fs_records.task import TaskResource  # noqa: F401


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


async def _bootstrap(client):
    resp = await client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return resp.json()


def _cn_url(bootstrap_payload: dict, sub: str) -> str:
    cn_id = bootstrap_payload["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


async def _create_skill(client, cn_url_base, name: str) -> str:
    """Create a skill record and return its id."""
    resp = await client.post(cn_url_base, json={"name": name, "description": f"{name} desc"})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


# ===========================================================================
# Scan
# ===========================================================================

@pytest.mark.asyncio
async def test_scan_per_type_returns_records(bootstrapped_client):
    """Per-type scan returns a records list with correct structure."""
    boot = await _bootstrap(bootstrapped_client)

    resp = await bootstrapped_client.get(_cn_url(boot, "scan") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["type"] == "skill"
    # Scan discovers skills from ~/.claude/skills/ — expect at least the user's real skills
    assert data["count"] >= 1
    assert "records" in data
    assert isinstance(data["records"], list)
    assert len(data["records"]) >= 1
    # Each record in the list must have a name
    for r in data["records"]:
        assert "name" in r


@pytest.mark.asyncio
async def test_scan_per_type_includes_byte_stats(bootstrapped_client):
    """Per-type scan response has min_bytes, max_bytes, avg_bytes."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "skill-delta")

    resp = await bootstrapped_client.get(_cn_url(boot, "scan") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "min_bytes" in data
    assert "max_bytes" in data
    assert "avg_bytes" in data
    assert "scan_ms" in data


@pytest.mark.asyncio
async def test_scan_unknown_type_returns_400(bootstrapped_client):
    """Scanning an unknown type returns HTTP 400."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.get(_cn_url(boot, "scan") + "?type=no_such_type")
    assert resp.status_code == 400
    assert "no_such_type" in resp.json()["message"]


# ===========================================================================
# Index
# ===========================================================================

@pytest.mark.asyncio
async def test_index_per_type_no_records(bootstrapped_client):
    """Index with no test-created records returns a valid response.

    Note: real skills from ~/.claude/skills/ may be discovered and indexed,
    so we only assert the response structure, not indexed == 0.
    """
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["type"] == "skill"
    assert isinstance(data["indexed"], int)


@pytest.mark.asyncio
async def test_index_per_type_with_records(bootstrapped_client):
    """Index indexes the records that exist on disk."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "indexed-skill-1")
    await _create_skill(bootstrapped_client, skill_base, "indexed-skill-2")

    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["type"] == "skill"
    assert data["indexed"] >= 2


@pytest.mark.asyncio
async def test_index_unknown_type_returns_400(bootstrapped_client):
    """Index of an unknown type returns HTTP 400."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=bogus_type")
    assert resp.status_code == 400
    assert "bogus_type" in resp.json()["message"]


# ===========================================================================
# Search
# ===========================================================================

@pytest.mark.asyncio
async def test_search_empty_query_no_filter_returns_empty(bootstrapped_client):
    """Search with no query and no filter returns empty results."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.get(_cn_url(boot, "search"))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["results"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_search_filter_only_browse_returns_records(bootstrapped_client):
    """GET /search?record_type=skill (no query) returns skill records — browse mode.

    Note: browse uses RecordList → SkillRecord.discover() which scans
    ~/.claude/skills/, so results include real user skills. We verify the
    response structure and that at least some skill records are returned.
    """
    boot = await _bootstrap(bootstrapped_client)

    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?record_type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "results" in data
    results = data["results"]
    # Browse discovers real skills from ~/.claude/skills/
    assert len(results) >= 1

    # Every result must have the correct shape
    for r in results:
        assert r["record_type"] == "skill"
        assert "name" in r
        assert "record_id" in r
        assert "status" in r
        assert "modified_at" in r
        assert "asset_ref" in r


@pytest.mark.asyncio
async def test_search_filter_only_unknown_type_returns_empty(bootstrapped_client):
    """GET /search?record_type=no_such_type returns empty (type not registered)."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?record_type=no_such_type")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["results"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_search_browse_respects_limit(bootstrapped_client):
    """Filter-only browse respects the limit param."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    for i in range(5):
        await _create_skill(bootstrapped_client, skill_base, f"limit-skill-{i}")

    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?record_type=skill&limit=3")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["results"]) <= 3


@pytest.mark.asyncio
async def test_search_combo_query_and_filter(bootstrapped_client):
    """Search with both q= and record_type= does not crash (NoOpIndexer returns empty)."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.get(
        _cn_url(boot, "search") + "?q=anything&record_type=skill"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "results" in data
    assert isinstance(data["results"], list)



# ===========================================================================
# Full cycle: scan → index → search
# (Regression tests for the two bugs fixed in this PR)
# ===========================================================================

@pytest.mark.asyncio
async def test_scan_then_index_then_search_full_cycle(bootstrapped_client):
    """Regression: create skill → scan discovers it → index → search finds it.

    This is the end-to-end test that would have caught both bugs:
    1. Record.sync_to_db() was storing entities with type='entity' instead of 'skill'
    2. fts_search silently returned [] because _schema_to_entity choked on
       raw-SQL date strings ('str' object has no attribute 'tzinfo')
    """
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")

    # Use a distinctive token that only appears in this skill's description
    unique_token = "unique_fts_regression_token_abc987"
    await _create_skill(bootstrapped_client, skill_base, f"FTS Regression Skill {unique_token}")

    # 1. Scan: should discover the skill
    resp = await bootstrapped_client.get(_cn_url(boot, "scan") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["count"] >= 1

    # 2. Index: POST /fs-records/index?type=skill
    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=skill")
    assert resp.status_code == 200
    assert resp.json()["data"]["indexed"] >= 1

    # 3. Search: the unique token must appear in results
    resp = await bootstrapped_client.get(
        _cn_url(boot, "search") + f"?q={unique_token}"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    results = data["results"]
    assert len(results) >= 1, (
        f"FTS search for '{unique_token}' returned no results after indexing. "
        "Check entity type storage in Record.sync_to_db() and date coercion in fts_search."
    )
    assert any(unique_token in r["name"] for r in results)


@pytest.mark.asyncio
async def test_search_with_record_type_filter_after_index(bootstrapped_client):
    """After indexing, search with record_type filter returns only matching type."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")

    unique_token = "type_filter_token_zxy456"
    await _create_skill(bootstrapped_client, skill_base, f"Filter Test Skill {unique_token}")

    # Index skills
    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=skill")
    assert resp.status_code == 200

    # Search with record_type=skill filter
    resp = await bootstrapped_client.get(
        _cn_url(boot, "search") + f"?q={unique_token}&record_type=skill"
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["results"]) >= 1
    # All results must be skills
    for r in data["results"]:
        assert r["record_type"] == "skill"
