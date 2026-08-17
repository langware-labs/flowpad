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

from typing import ClassVar

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.indexer.functions.task import extract_task  # noqa: F401
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

TaskResource = FSRecord  # noqa: F401


class _RecentActivityAlpha(Entity):
    type: str = APIField(default="recent_activity_alpha")
    scope: str = APIField(default="")
    project_id: str | None = APIField(default=None)

    _api_visible: ClassVar[bool] = True


class _RecentActivityBeta(Entity):
    type: str = APIField(default="recent_activity_beta")
    scope: str = APIField(default="")
    project_id: str | None = APIField(default=None)

    _api_visible: ClassVar[bool] = True


class _RecentActivityInfrastructure(Entity):
    type: str = APIField(default="recent_activity_infrastructure")

    _api_visible: ClassVar[bool] = True


# The registry flag is the generic infrastructure signal consumed by the
# recent-activity projection (the real built-ins using it are Tab and
# DataSourceCursor). Registering a probe keeps this test independent of those
# types' unrelated required fields.
SchemaRegistry.register(
    TypeInfo(
        type_name=_RecentActivityInfrastructure.get_type(),
        entity_cls=_RecentActivityInfrastructure,
        api_visible=True,
        db_only=True,
    )
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path, monkeypatch):
    """Redirect all record I/O to a temp directory for test isolation.

    Also redirects HOME/USERPROFILE to a temp dir so the indexer's
    USER_HOME_FOLDER root (Path.home()) does not walk the developer's real
    ~/.claude/skills/, which can hold hundreds of test-fixture leftovers and
    blow the 30s test timeout on cold metadata writes.

    FLOW_INSTANCE=test + FLOWPAD_TEST_SANDBOX route _resolve_scope_root
    through TestInstanceSettings so asset_ref computation lands inside the
    sandbox; without these the cached oss-instance Path.home() wins and
    skill markdown is written into the developer's real ~/.claude/skills/.

    records_root and fake_home are siblings — never nest fake_home under
    records_root, or upsert_main_ref's shadow guard refuses to write
    SKILL.md (the asset path would be a descendant of records_root).
    """
    from flow_sdk.fs_store.indexer import reset_shared_indexer
    from flow_sdk.instance_settings import reset_instance_settings
    original = get_default_records_root()
    records_root = tmp_path / "records"
    records_root.mkdir()
    set_default_records_root(records_root)
    fake_home = tmp_path / "_home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(fake_home))
    reset_instance_settings()
    # The shared indexer caches default_roots() at construction time, so a
    # cached oss-instance indexer would still walk the developer's real home
    # even after we rebind InstanceSettings — force a rebuild against the
    # sandbox.
    reset_shared_indexer()
    yield tmp_path
    set_default_records_root(original)
    reset_instance_settings()
    reset_shared_indexer()


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


@pytest.mark.asyncio
async def test_create_materializes_folder_asset_main_body(bootstrapped_client):
    """A folder-backed asset created via fs-records POST must have its main body
    (default_body → SKILL.md) written to disk, so a disk-walking scan can find
    it — regardless of what other tests left behind. Regression: the create wrote
    only the DB row + metadata.json shadow, so scan?type=skill saw count 0 unless
    a prior test happened to leave a skill on disk (order-dependent flake)."""
    from pathlib import Path

    boot = await _bootstrap(bootstrapped_client)
    sid = await _create_skill(bootstrapped_client, _cn_url(boot, "skill"), "materialize-body-skill")

    skill = (await bootstrapped_client.get(f"/api/v1/graph/skill/{sid}")).json()["data"]
    folder = Path(skill["asset_ref"])
    assert (folder / "SKILL.md").is_file(), (
        f"create did not materialize SKILL.md at {folder}"
    )


# ===========================================================================
# Scan
# ===========================================================================

@pytest.mark.asyncio
async def test_scan_per_type_returns_records(bootstrapped_client):
    """Per-type scan returns a records list with correct structure."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "scan-per-type-skill")

    resp = await bootstrapped_client.get(_cn_url(boot, "scan") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["type"] == "skill"
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

# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_index_per_type_no_records(bootstrapped_client):
    """Index with no test-created records returns a valid response."""
    boot = await _bootstrap(bootstrapped_client)
    resp = await bootstrapped_client.post(_cn_url(boot, "index") + "?type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["type"] == "skill"
    assert isinstance(data["indexed"], int)


# do not increase timeout without approval
@pytest.mark.timeout(30)
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
async def test_recent_activity_mixed_browse_filters_then_pages(bootstrapped_client):
    """Mixed edit recency is SQL-ordered, registry-filtered, then paged."""
    boot = await _bootstrap(bootstrapped_client)

    rows = [
        _RecentActivityAlpha(id=mint_uuid(), name="older", last_edited_at=100),
        _RecentActivityBeta(id=mint_uuid(), name="newer", last_edited_at=300),
        _RecentActivityAlpha(id=mint_uuid(), name="unstamped"),
        _RecentActivityAlpha(
            id=mint_uuid(),
            name="scope-filtered",
            scope="user",
            last_edited_at=400,
        ),
        _RecentActivityBeta(
            id=mint_uuid(),
            name="system-filtered",
            system=True,
            last_edited_at=500,
        ),
        _RecentActivityInfrastructure(
            id=mint_uuid(),
            name="infrastructure-filtered",
            last_edited_at=600,
        ),
    ]
    for row in rows:
        await row.save()

    base = _cn_url(boot, "search")
    first = await bootstrapped_client.get(
        base + "?sort_by=last_edited_at&limit=1&offset=0&user=false"
    )
    assert first.status_code == 200
    first_data = first.json()["data"]
    assert first_data["total"] == 2
    assert [row["name"] for row in first_data["results"]] == ["newer"]
    assert first_data["results"][0]["last_edited_at"] == 300

    second = await bootstrapped_client.get(
        base + "?sort_by=last_edited_at&limit=1&offset=1&user=false"
    )
    assert second.status_code == 200
    second_data = second.json()["data"]
    assert second_data["total"] == 2
    assert [row["name"] for row in second_data["results"]] == ["older"]
    assert second_data["results"][0]["last_edited_at"] == 100


@pytest.mark.asyncio
async def test_search_filter_only_browse_returns_records(bootstrapped_client):
    """GET /search?record_type=skill (no query) returns skill records — browse mode."""
    boot = await _bootstrap(bootstrapped_client)
    skill_base = _cn_url(boot, "skill")
    await _create_skill(bootstrapped_client, skill_base, "browse-mode-skill")

    resp = await bootstrapped_client.get(_cn_url(boot, "search") + "?record_type=skill")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "results" in data
    results = data["results"]
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
