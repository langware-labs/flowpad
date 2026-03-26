"""Tests for DataManager — split-phase indexing with real JSONL session records.

Uses tmp_path for JSONL files and an isolated SQLite driver. No HTTP layer.
The key regression test verifies that Entity.search() finds terms from
session transcripts after the 3-phase DataManager pipeline runs.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


# ---------------------------------------------------------------------------
# JSONL fixture helpers
# ---------------------------------------------------------------------------

def _write_session_jsonl(path: Path, session_id: str, messages: list[str]) -> None:
    """Write a minimal Claude session JSONL file with real message structure."""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "sessionId": session_id,
            "cwd": "/tmp/test_project",
            "slug": "test-project",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "version": "1.0.0",
            "type": "system",
            "message": {"role": "system", "content": "You are a helpful assistant."},
        }) + "\n")
        # Note: parser expects "type": "user" for human turns (not "human")
        for i, msg in enumerate(messages):
            entry_type = "user" if i % 2 == 0 else "assistant"
            fh.write(json.dumps({
                "sessionId": session_id,
                "type": entry_type,
                "message": {
                    "role": "user" if entry_type == "user" else "assistant",
                    "content": [{"type": "text", "text": msg}],
                },
                "timestamp": f"2026-01-01T00:0{i}:00.000Z",
            }) + "\n")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def dm_env(tmp_path, monkeypatch):
    """Isolated DB driver + fake Claude projects directory.

    Monkeypatches ClaudeSessionRecord.discover_paths_iter to scan
    tmp_path/projects/ instead of ~/.claude/projects/.
    """
    db_path = str(tmp_path / "dm_test.db")
    cfg = DBConfig()
    cfg.database = db_path
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.record_types import RecordType
    try:
        from flow_sdk.schema.entity_factory import type_registry
        if type_registry.get(RecordType.CLAUDE_SESSION) is None:
            type_registry.register(RecordType.CLAUDE_SESSION, Entity)
    except Exception:
        pass

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances["sqlite"] = driver

    from flow_sdk.db.db_entity import DBEntity
    old_db = DBEntity.__dict__.get("_db")
    DBEntity._db = driver  # type: ignore[attr-defined]

    from flow_sdk.fs_store import get_default_records_root, set_default_records_root
    original_records_root = get_default_records_root()
    set_default_records_root(tmp_path / "records")

    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()

    def _fake_discover_paths_iter(cls, limit=None, **kwargs):
        count = 0
        for f in sorted(projects_dir.glob("*.jsonl")):
            yield f
            count += 1
            if limit is not None and count >= limit:
                return

    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
    monkeypatch.setattr(
        ClaudeSessionRecord,
        "discover_paths_iter",
        classmethod(_fake_discover_paths_iter),
    )

    yield driver, projects_dir

    set_default_records_root(original_records_root)
    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        try:
            del DBEntity._db  # type: ignore[attr-defined]
        except AttributeError:
            pass
    else:
        DBEntity._db = old_db  # type: ignore[attr-defined]
    await driver.close()


# ---------------------------------------------------------------------------
# search_title / search_content unit tests
# ---------------------------------------------------------------------------

def test_search_title_reads_jsonl(tmp_path):
    """search_title returns last user message directly from JSONL."""
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

    sid = str(uuid.uuid4())
    p = tmp_path / f"{sid}.jsonl"
    _write_session_jsonl(p, sid, ["explain the v0.2.3 release", "sure, here is the summary"])

    rec = ClaudeSessionRecord.from_jsonl(p)
    assert rec.search_title is not None
    assert "v0.2.3" in rec.search_title or "explain" in rec.search_title


def test_search_content_reads_jsonl(tmp_path):
    """search_content contains transcript lines directly from JSONL."""
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

    sid = str(uuid.uuid4())
    unique = f"unique_term_{uuid.uuid4().hex[:8]}"
    p = tmp_path / f"{sid}.jsonl"
    _write_session_jsonl(p, sid, [f"user asks about {unique}", "assistant answers"])

    rec = ClaudeSessionRecord.from_jsonl(p)
    content = rec.search_content
    assert content is not None
    assert unique in content, f"Expected '{unique}' in search_content, got: {content[:200]}"


def test_search_content_returns_none_when_no_path(tmp_path):
    """search_content returns None when no JSONL path is set."""
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
    rec = ClaudeSessionRecord.__new__(ClaudeSessionRecord)
    assert rec.search_content is None
    assert rec.search_title is None


# ---------------------------------------------------------------------------
# DataManager.scan() tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_scan_finds_jsonl_files(dm_env):
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions

    sid = str(uuid.uuid4())
    _write_session_jsonl(projects_dir / f"{sid}.jsonl", sid, ["hello"])

    result = await DataManager().scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))

    assert result.total >= 1
    assert RecordType.CLAUDE_SESSION in result.by_type
    assert len(result.by_type[RecordType.CLAUDE_SESSION]) >= 1


@pytest.mark.asyncio
async def test_scan_respects_limit(dm_env):
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions

    for _ in range(5):
        sid = str(uuid.uuid4())
        _write_session_jsonl(projects_dir / f"{sid}.jsonl", sid, ["msg"])

    result = await DataManager().scan(ScanOptions(types=[RecordType.CLAUDE_SESSION], limit=3))
    assert result.total <= 3


@pytest.mark.asyncio
async def test_scan_returns_no_db_writes(dm_env):
    """scan() must not write to the DB — it's discovery only."""
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions

    sid = str(uuid.uuid4())
    _write_session_jsonl(projects_dir / f"{sid}.jsonl", sid, ["hello"])

    await DataManager().scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))

    entities = await Entity.get_all(QueryFilter(type=str(RecordType.CLAUDE_SESSION)))
    assert len(entities) == 0


# ---------------------------------------------------------------------------
# DataManager.index_meta() tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_index_meta_creates_entity_rows(dm_env):
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexMetaOptions

    sid = str(uuid.uuid4())
    _write_session_jsonl(projects_dir / f"{sid}.jsonl", sid, ["hello db"])

    dm = DataManager()
    discovery = await dm.scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))
    result = await dm.index_meta(discovery.records, IndexMetaOptions())

    assert result.indexed >= 1
    assert result.errors == 0

    entities = await Entity.get_all(QueryFilter(type=str(RecordType.CLAUDE_SESSION)))
    assert len(entities) >= 1


@pytest.mark.asyncio
async def test_index_meta_skip_fresh(dm_env):
    """Second run with skip_fresh=True skips records with hash sentinels."""
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexMetaOptions

    sid = str(uuid.uuid4())
    _write_session_jsonl(projects_dir / f"{sid}.jsonl", sid, ["hello"])

    dm = DataManager()
    discovery = await dm.scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))

    r1 = await dm.index_meta(discovery.records, IndexMetaOptions())
    assert r1.indexed >= 1

    r2 = await dm.index_meta(discovery.records, IndexMetaOptions(skip_fresh=True))
    assert r2.skipped >= 1
    assert r2.indexed == 0


# ---------------------------------------------------------------------------
# Core regression: FTS search finds transcript content
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_finds_transcript_term(dm_env):
    """Regression: without load_fts_content(), search_content returns 'slug cwd' and
    Entity.search() returns 0 results for transcript terms. With the fix, the full
    JSONL is parsed and the term is indexed.
    """
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexMetaOptions, IndexSearchOptions

    sid = str(uuid.uuid4())
    unique = f"regression_fix_{uuid.uuid4().hex[:10]}"
    _write_session_jsonl(
        projects_dir / f"{sid}.jsonl",
        sid,
        [f"Deploy {unique} to production", "Sure, deploying now."],
    )

    dm = DataManager()
    discovery = await dm.scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))
    assert discovery.total >= 1

    meta = await dm.index_meta(discovery.records, IndexMetaOptions())
    assert meta.indexed >= 1
    assert meta.errors == 0

    search = await dm.index_search(discovery.records, IndexSearchOptions())
    assert search.indexed >= 1
    assert search.errors == 0

    results = await Entity.search(unique)
    assert len(results) >= 1, (
        f"Entity.search('{unique}') returned no results after index_search()."
    )
    assert sid in [r.id for r in results], f"Expected session id={sid} in results"


@pytest.mark.asyncio
async def test_search_content_is_not_just_slug_cwd(dm_env):
    """FTS content must be the full transcript, not the 'slug cwd' fallback."""
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexMetaOptions, IndexSearchOptions

    sid = str(uuid.uuid4())
    _write_session_jsonl(
        projects_dir / f"{sid}.jsonl",
        sid,
        ["what is the meaning of life", "it is 42"],
    )

    dm = DataManager()
    discovery = await dm.scan(ScanOptions(types=[RecordType.CLAUDE_SESSION]))
    await dm.index_meta(discovery.records, IndexMetaOptions())
    await dm.index_search(discovery.records, IndexSearchOptions())

    rec = discovery.records[0]
    content = rec.search_content
    assert content is not None
    assert len(content) > 50, f"search_content looks like the slug/cwd fallback: {content!r}"
    assert "meaning" in content or "life" in content or "42" in content


# ---------------------------------------------------------------------------
# DataManager.index_all() convenience method
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_index_all_equivalent_to_phases(dm_env):
    """index_all() produces same result as scan + index_meta + index_search."""
    _driver, projects_dir = dm_env
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.data_manager import DataManager, IndexAllOptions

    sid = str(uuid.uuid4())
    unique = f"all_in_one_{uuid.uuid4().hex[:10]}"
    _write_session_jsonl(
        projects_dir / f"{sid}.jsonl",
        sid,
        [f"Help me with {unique}", "Of course!"],
    )

    result = await DataManager().index_all(IndexAllOptions(types=[RecordType.CLAUDE_SESSION]))

    assert result.discovery.total >= 1
    assert result.meta.indexed >= 1
    assert result.search.indexed >= 1
    assert result.meta.errors == 0
    assert result.search.errors == 0

    results = await Entity.search(unique)
    assert len(results) >= 1, f"Entity.search('{unique}') returned no results after index_all()."
