"""DB-checksum parity test: FSIndexer.index() vs the legacy FS walker path.

Compares only the FS-walk-and-parse path (not DB-backed records_root records).
The legacy equivalent is the per-class `_external_source_iter()` (or
`discover_iter()` for classes without the former), followed by per-record
`sync_to_db`. That's the path our indexer replaces.

Per terminal type:
  1. Clear entities + FTS for the type
  2. Run legacy: iterate `_external_source_iter` / `discover_iter`, sync_to_db each
  3. Checksum over `(id, type, data, schema_version)` rows ordered by id
  4. Clear again
  5. Run `FSIndexer.index(types=[T], include_temp=True)`
  6. Checksum
  7. Assert entity-row checksum + FTS row count match

Types excluded from parity:
  - TASK: legacy has no walker at all (notification_scanner is a
    different subsystem); index-level comparison not meaningful.
  - CLAUDE_HOOK: plugin_name derivation differs (registry vs path) causing
    intentional record.data drift; phase 3 doesn't try to match.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, default_roots
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
from flow_sdk.fs_store.indexer.functions.real_project_cwd import real_project_cwd_fn
from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
from flow_sdk.fs_store.indexer.functions.claude_md import (
    claude_md_in_claude_subdir_fn, claude_md_in_project_root_fn,
)
from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
from flow_sdk.fs_store.indexer.functions.spec import spec_project_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.workflow import workflow_fn
from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
from flow_sdk.fs_store.indexer.functions.markdown import (
    markdown_flat_fn, markdown_with_docs_subdirs_fn,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry


PARITY_TYPES = [
    RecordType.CLAUDE_SESSION,
    RecordType.PROJECT,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_RULES,
    RecordType.SPEC,
    RecordType.SKILL,
    RecordType.AGENT,
    RecordType.WORKFLOW,
    RecordType.COMMAND,
    RecordType.CLAUDE_MEMORY,
    RecordType.MARKDOWN,
]


def _build_indexer() -> FSIndexer:
    idx = FSIndexer(state_dir=Path("/tmp/indexer_state"), roots=default_roots())

    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, real_project_cwd_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_rules_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, command_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)

    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    idx.add_function(RecordType.PROJECT, claude_memory_fn)

    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_plan_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_rules_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, spec_project_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, workflow_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, markdown_with_docs_subdirs_fn)

    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, markdown_flat_fn)

    idx.add_function(RecordType.CWD_ROOT, claude_plan_fn)
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn)
    idx.add_function(RecordType.CWD_ROOT, skill_fn)
    idx.add_function(RecordType.CWD_ROOT, agent_fn)
    idx.add_function(RecordType.CWD_ROOT, workflow_fn)
    idx.add_function(RecordType.CWD_ROOT, command_fn)
    idx.add_function(RecordType.CWD_ROOT, markdown_with_docs_subdirs_fn)

    return idx


async def _checksum_entities(driver, type_name: str) -> str:
    from sqlalchemy import text

    async with await driver._get_session() as session:
        result = await session.execute(
            text(
                "SELECT id, type, data, schema_version FROM entities "
                "WHERE type = :t ORDER BY id"
            ),
            {"t": type_name},
        )
        rows = result.fetchall()

    h = hashlib.sha256()
    h.update(f"n={len(rows)}\n".encode())
    for r in rows:
        h.update(f"{r[0]}|{r[1]}|{r[2]}|{r[3]}\n".encode())
    return h.hexdigest()


async def _count_fts(driver, type_name: str) -> int:
    from sqlalchemy import text

    async with await driver._get_session() as session:
        result = await session.execute(
            text("SELECT COUNT(*) FROM entities_fts WHERE type = :t"),
            {"t": type_name},
        )
        row = result.fetchone()
    return int(row[0]) if row else 0


async def _legacy_fs_walk_index(driver, record_type: RecordType) -> None:
    """Iterate the legacy FS walker for this type + sync_to_db per record.

    Chooses the most appropriate walker:
      - `_external_source_iter` if overridden (markdown, plan, skill, ...)
      - else `discover_iter` (claude_session, ...)
    Does NOT include records_root — only the FS discovery path.
    """
    info = SchemaRegistry.get(str(record_type))
    if info is None or info.record_cls is None:
        return
    cls = info.record_cls

    # Check class.__dict__ for *owned* method — getattr returns the inherited
    # base (which yields nothing) and can compare != to itself in odd ways.
    if "_external_source_iter" in cls.__dict__:
        records_iter = cls._external_source_iter()
    elif "discover_iter" in cls.__dict__:
        records_iter = cls.discover_iter()
    else:
        return

    fts_batch: list = []
    for rec in records_iter:
        try:
            await rec.sync_to_db(fts_batch=fts_batch, notify=False)
        except Exception:
            pass

    if fts_batch and hasattr(driver, "fts_upsert"):
        await driver.fts_upsert(fts_batch)


@pytest.mark.timeout(300)
@pytest.mark.parametrize(
    "record_type",
    PARITY_TYPES,
    ids=[str(rt) for rt in PARITY_TYPES],
)
@pytest.mark.asyncio
async def test_index_db_state_matches_legacy_fs_walk(record_type: RecordType) -> None:
    driver = get_db_driver()
    type_name = str(record_type)

    # --- legacy FS walk ---
    await driver.delete_entities_by_type(type_name)
    await driver.fts_clear()
    await _legacy_fs_walk_index(driver, record_type)
    legacy_cksum = await _checksum_entities(driver, type_name)
    legacy_fts = await _count_fts(driver, type_name)
    legacy_rows = await driver.count_entities_by_type(type_name)

    # --- indexer run (include_temp=True matches legacy's no-filter walk) ---
    await driver.delete_entities_by_type(type_name)
    await driver.fts_clear()
    indexer = _build_indexer()
    await indexer.index(
        IndexerOptions(verbose=False, include_temp=True, types=[record_type])
    )
    idx_cksum = await _checksum_entities(driver, type_name)
    idx_fts = await _count_fts(driver, type_name)
    idx_rows = await driver.count_entities_by_type(type_name)

    # --- compare ---
    assert legacy_rows == idx_rows, (
        f"{type_name}: entity row count drift — legacy={legacy_rows} idx={idx_rows}"
    )
    assert legacy_cksum == idx_cksum, (
        f"{type_name}: entity-table checksum drift "
        f"(n={legacy_rows}) legacy={legacy_cksum[:16]} idx={idx_cksum[:16]}"
    )
    assert legacy_fts == idx_fts, (
        f"{type_name}: FTS row count drift — legacy={legacy_fts} idx={idx_fts}"
    )
