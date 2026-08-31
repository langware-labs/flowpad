"""RSIndexerAdapter contract tests against a stub binary.

Covers: progress-line translation, IndexResult mapping, scan candidate →
FSRef materialization, and the backend-toggle fail-open (no binary → Python
FSIndexer)."""
from __future__ import annotations

import stat
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.builtin import (
    build_default_indexer,
    reset_shared_indexer,
)
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.rs_adapter import (
    ENV_INDEXER_BACKEND,
    ENV_RS_INDEXER_BIN,
    RSIndexerAdapter,
)
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.timeout(10)


_STUB = """#!/usr/bin/env python3
import json, sys
argv = sys.argv[1:]
cmd = argv[0] if argv else ""
if cmd == "scan":
    print(json.dumps({"job_name": "scan", "rows": [], "current": None,
                      "done": 0, "total": 0, "text": None, "ts": "t0"}))
    print(json.dumps({"path": "/tmp/rsstub/skills/demo/SKILL.md",
                      "record_type": "skill", "scope": "user",
                      "project_id": "", "json_path": ""}))
    print(json.dumps({"path": "/tmp/rsstub/.claude/settings.json",
                      "record_type": "claude_hook", "scope": "project",
                      "project_id": "pid-1", "json_path": "/hooks/Stop/0/hooks/0"}))
    print(json.dumps({"job_name": "scan", "rows": [], "current": None,
                      "done": 2, "total": 0, "text": "complete", "ts": "t1"}))
elif cmd == "index":
    print(json.dumps({"job_name": "index",
                      "rows": [{"type_name": "skill", "done": 1, "total": 2,
                                 "errors": 0, "skipped": 0}],
                      "current": "skill", "done": 1, "total": 2,
                      "text": None, "ts": "t0"}))
    print(json.dumps({"job_name": "index",
                      "rows": [{"type_name": "skill", "done": 2, "total": 2,
                                 "errors": 1, "skipped": 1}],
                      "current": None, "done": 2, "total": 2,
                      "text": "complete", "ts": "t1"}))
    print(json.dumps({"result": {
        "per_type": {"skill": {"indexed": 1, "errors": 1, "duration_ms": 5.0,
                                "skipped": 1, "orphans_found": 2,
                                "orphans_db_removed": 1, "orphans_disk_removed": 0,
                                "orphan_ids": ["a", "b"]}},
        "total_indexed": 1, "total_errors": 1, "duration_ms": 6.5,
        "total_orphans_found": 2, "total_orphans_db_removed": 1,
        "total_orphans_disk_removed": 0}}))
else:
    sys.exit(1)
"""


@pytest.fixture()
def stub_bin(tmp_path: Path) -> Path:
    p = tmp_path / "fsindexer-rs-stub"
    p.write_text(_STUB, encoding="utf-8")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return p


@pytest.mark.asyncio
async def test_index_translates_progress_and_result(stub_bin: Path):
    adapter = RSIndexerAdapter(stub_bin)
    tables = []

    async def on_progress(t):
        tables.append(t)

    result = await adapter.index(IndexerOptions(verbose=False, on_progress=on_progress))

    assert [t.text for t in tables] == [None, "complete"]
    assert tables[0].job_name == "index"
    assert tables[0].rows[0].type_name == "skill"
    assert tables[1].rows[0].skipped == 1

    pt = result.per_type[RecordType.SKILL]
    assert (pt.indexed, pt.errors, pt.skipped) == (1, 1, 1)
    assert pt.orphans_found == 2 and pt.orphans_db_removed == 1
    assert pt.orphan_ids == ("a", "b")
    assert result.total_indexed == 1 and result.total_errors == 1


@pytest.mark.asyncio
async def test_scan_materializes_fsrefs(stub_bin: Path):
    adapter = RSIndexerAdapter(stub_bin)
    refs = await adapter.scan(IndexerOptions(verbose=False))
    assert len(refs) == 2
    skill, hook = refs
    assert skill.record_type == RecordType.SKILL
    assert skill.scope == "user"
    assert hook.record_type == RecordType.CLAUDE_HOOK
    assert hook.project_id == "pid-1"
    assert hook.json_path == "/hooks/Stop/0/hooks/0"


def test_toggle_fail_open_without_binary(monkeypatch):
    monkeypatch.setenv(ENV_INDEXER_BACKEND, "rust")
    monkeypatch.delenv(ENV_RS_INDEXER_BIN, raising=False)
    reset_shared_indexer()
    try:
        idx = build_default_indexer()
        assert isinstance(idx, FSIndexer)
    finally:
        reset_shared_indexer()


def test_toggle_selects_adapter_with_binary(monkeypatch, stub_bin: Path):
    monkeypatch.setenv(ENV_INDEXER_BACKEND, "rust")
    monkeypatch.setenv(ENV_RS_INDEXER_BIN, str(stub_bin))
    reset_shared_indexer()
    try:
        idx = build_default_indexer()
        assert isinstance(idx, RSIndexerAdapter)
    finally:
        reset_shared_indexer()


def test_default_backend_is_python(monkeypatch):
    monkeypatch.delenv(ENV_INDEXER_BACKEND, raising=False)
    monkeypatch.delenv(ENV_RS_INDEXER_BIN, raising=False)
    reset_shared_indexer()
    try:
        idx = build_default_indexer()
        assert isinstance(idx, FSIndexer)
    finally:
        reset_shared_indexer()
