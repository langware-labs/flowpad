"""Tests for the TranscriptIndexer + PlanHandler pipeline.

Real DB + real JSONL files under tmp_path. No mocks (per repo policy).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import ClaudePlan
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.transcript_indexer import (
    TranscriptContext,
    TranscriptIndexer,
)
from flow_sdk.fs_store.transcript_indexer.handlers import PlanHandler
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
from flow_sdk.transcript_analyzer.entry import EntryKind, TranscriptEntry


# ── helpers ─────────────────────────────────────────────────────────────────


_SAMPLE_SESSION_ID = "11111111-1111-4111-8111-111111111111"


def _user_msg_line(session_id: str, uuid_hex: str, text: str = "hi") -> str:
    return json.dumps({
        "parentUuid": None,
        "isSidechain": False,
        "type": "user",
        "message": {"role": "user", "content": text},
        "uuid": uuid_hex,
        "timestamp": "2026-04-26T13:12:32.389Z",
        "userType": "external",
        "entrypoint": "cli",
        "cwd": "/repo",
        "sessionId": session_id,
        "version": "2.1.119",
        "gitBranch": "main",
    })


def _exit_plan_line(
    session_id: str,
    plan_file_path: str | None,
    uuid_hex: str = "00000000-0000-4000-8000-0000000003e9",
) -> str:
    tool_input: dict = {"plan": "# Plan body"}
    if plan_file_path is not None:
        tool_input["planFilePath"] = plan_file_path
    return json.dumps({
        "parentUuid": "00000000-0000-4000-8000-000000000385",
        "isSidechain": False,
        "type": "assistant",
        "message": {
            "model": "claude-opus-4-7",
            "id": "msg_test_plan",
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_test_plan",
                "name": "ExitPlanMode",
                "input": tool_input,
            }],
            "stop_reason": "tool_use",
        },
        "requestId": "req_test_plan",
        "uuid": uuid_hex,
        "timestamp": "2026-04-28T16:15:35.039Z",
        "userType": "external",
        "entrypoint": "cli",
        "cwd": "/repo",
        "sessionId": session_id,
        "version": "2.1.119",
        "gitBranch": "main",
        "slug": "plan-slug",
    })


def _write_transcript(
    home: Path,
    session_id: str = _SAMPLE_SESSION_ID,
    plan_file_path: str | None = "/tmp/sample-plan.md",
    encoded_project: str = "-Users-alice-repo-a",
) -> Path:
    project_dir = home / ".claude" / "projects" / encoded_project
    project_dir.mkdir(parents=True, exist_ok=True)
    jsonl = project_dir / f"{session_id}.jsonl"
    lines = [
        _user_msg_line(session_id, "00000000-0000-4000-8000-0000000000c9", "hi"),
        _exit_plan_line(session_id, plan_file_path),
    ]
    jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return jsonl


def _write_plan_md(home: Path, slug: str = "sample-plan", body: str = "# Plan\n") -> Path:
    plans = home / ".claude" / "plans"
    plans.mkdir(parents=True, exist_ok=True)
    md = plans / f"{slug}.md"
    md.write_text(body, encoding="utf-8")
    return md


async def _save_plan_entity(asset_ref: str, name: str = "Sample plan") -> ClaudePlan:
    plan = ClaudePlan(id=str(uuid.uuid4()), name=name, asset_ref=asset_ref)
    await plan.save()
    return plan


async def _save_agentic_process(session_id: str) -> AgenticProcess:
    proc = AgenticProcess(id=str(uuid.uuid4()), session_id=session_id)
    await proc.save()
    return proc


@pytest.fixture
async def clean_db():
    """Wipe entity types touched by these tests before/after each run."""
    driver = get_db_driver()
    types = (
        RecordType.CLAUDE_SESSION,
        RecordType.PROJECT,
        RecordType.PLAN,
        "agentic_process",
    )
    for rt in types:
        await driver.delete_entities_by_type(str(rt))
    yield driver
    for rt in types:
        await driver.delete_entities_by_type(str(rt))


# ── dispatch tests (handler-level, no DB writes) ────────────────────────────


class _SpyHandler:
    """Captures every entry it's called with for assertion."""

    match_kind: ClassVar[EntryKind | None]
    match_tool_name: ClassVar[str | None]

    def __init__(
        self,
        kind: EntryKind | None = None,
        tool_name: str | None = None,
    ) -> None:
        # ClassVar shadowing on instance is fine for our protocol use.
        type(self).match_kind = kind
        type(self).match_tool_name = tool_name
        self.calls: list[tuple[TranscriptEntry, TranscriptContext]] = []

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None:
        self.calls.append((entry, ctx))


def _make_spy(kind=None, tool_name=None) -> _SpyHandler:
    # Re-create the class per spy so class-level match attrs don't clobber.
    cls = type("_SpyHandler_dyn", (_SpyHandler,), {})
    s = cls.__new__(cls)
    _SpyHandler.__init__(s, kind=kind, tool_name=tool_name)
    return s


@pytest.mark.asyncio
async def test_dispatch_routes_tool_use_to_handler_by_tool_name(tmp_path: Path) -> None:
    home = tmp_path / "home"
    jsonl = _write_transcript(home, plan_file_path="/tmp/some-plan.md")
    spy = _make_spy(kind=EntryKind.TOOL_USE, tool_name="ExitPlanMode")

    ti = TranscriptIndexer()
    ti.add_handler(spy)
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    assert len(spy.calls) == 1
    entry, ctx = spy.calls[0]
    assert isinstance(entry, ExitPlanModeEntry)
    assert entry.plan_file_path == "/tmp/some-plan.md"
    assert entry.session_id == _SAMPLE_SESSION_ID
    assert ctx.jsonl_path == jsonl


@pytest.mark.asyncio
async def test_dispatch_routes_by_kind_only(tmp_path: Path) -> None:
    home = tmp_path / "home"
    jsonl = _write_transcript(home)
    spy = _make_spy(kind=EntryKind.USER_MESSAGE)

    ti = TranscriptIndexer()
    ti.add_handler(spy)
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    assert len(spy.calls) == 1
    entry, _ = spy.calls[0]
    assert entry.kind == EntryKind.USER_MESSAGE


@pytest.mark.asyncio
async def test_dispatch_no_match_is_noop(tmp_path: Path) -> None:
    home = tmp_path / "home"
    jsonl = _write_transcript(home)
    spy = _make_spy(kind=EntryKind.SUMMARY)  # fixture has no summary line

    ti = TranscriptIndexer()
    ti.add_handler(spy)
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    assert spy.calls == []


@pytest.mark.asyncio
async def test_indexer_with_no_handlers_is_noop(tmp_path: Path) -> None:
    home = tmp_path / "home"
    jsonl = _write_transcript(home)
    ti = TranscriptIndexer()
    out = await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )
    assert out == []


# ── PlanHandler cross-link tests ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_plan_handler_creates_cross_link(tmp_path: Path, clean_db) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)
    jsonl = _write_transcript(home, plan_file_path=str(plan_md))

    plan = await _save_plan_entity(str(plan_md))
    proc = await _save_agentic_process(_SAMPLE_SESSION_ID)

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    plan_reloaded = await ClaudePlan.get_by_id(plan.id)
    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert plan_reloaded is not None
    assert proc_reloaded is not None
    plan_links = {(t.type, t.id) for t in plan_reloaded.private_context_entities_}
    proc_links = {(t.type, t.id) for t in proc_reloaded.private_context_entities_}
    assert (AgenticProcess.get_type(), proc.id) in plan_links
    assert (ClaudePlan.get_type(), plan.id) in proc_links


@pytest.mark.asyncio
async def test_plan_handler_idempotent_on_replay(tmp_path: Path, clean_db) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)
    jsonl = _write_transcript(home, plan_file_path=str(plan_md))

    plan = await _save_plan_entity(str(plan_md))
    proc = await _save_agentic_process(_SAMPLE_SESSION_ID)

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    ref = FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)
    await ti([ref], IndexerOptions(verbose=False))
    await ti([ref], IndexerOptions(verbose=False))

    plan_reloaded = await ClaudePlan.get_by_id(plan.id)
    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    plan_links = [(t.type, t.id) for t in plan_reloaded.private_context_entities_]
    proc_links = [(t.type, t.id) for t in proc_reloaded.private_context_entities_]
    assert plan_links.count((AgenticProcess.get_type(), proc.id)) == 1
    assert proc_links.count((ClaudePlan.get_type(), plan.id)) == 1


@pytest.mark.asyncio
async def test_plan_handler_no_agentic_process_is_skipped(
    tmp_path: Path, clean_db,
) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)
    jsonl = _write_transcript(home, plan_file_path=str(plan_md))

    plan = await _save_plan_entity(str(plan_md))
    # No AP saved.

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    plan_reloaded = await ClaudePlan.get_by_id(plan.id)
    assert plan_reloaded.private_context_entities_ == []


@pytest.mark.asyncio
async def test_plan_handler_triggers_scoped_plan_reindex_when_missing(
    tmp_path: Path, clean_db,
) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)  # exists on disk
    jsonl = _write_transcript(home, plan_file_path=str(plan_md))

    # No ClaudePlan entity saved up-front — PlanHandler must reindex.
    proc = await _save_agentic_process(_SAMPLE_SESSION_ID)

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    plan = await ClaudePlan.get_one({"asset_ref": str(plan_md)})
    assert plan is not None, "scoped PLAN reindex should have produced an entity"
    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    proc_links = {(t.type, t.id) for t in proc_reloaded.private_context_entities_}
    assert (ClaudePlan.get_type(), plan.id) in proc_links


@pytest.mark.asyncio
async def test_plan_handler_skips_when_scoped_reindex_yields_no_plan(
    tmp_path: Path, clean_db,
) -> None:
    # File exists but NOT under a `.claude/plans/` ancestor — claude_plan_fn
    # won't find it.
    stray = tmp_path / "stray.md"
    stray.write_text("# stray\n", encoding="utf-8")

    home = tmp_path / "home"
    jsonl = _write_transcript(home, plan_file_path=str(stray))
    proc = await _save_agentic_process(_SAMPLE_SESSION_ID)

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    assert await ClaudePlan.get_one({"asset_ref": str(stray)}) is None
    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert proc_reloaded.private_context_entities_ == []


@pytest.mark.asyncio
async def test_plan_handler_skips_when_plan_file_path_missing(
    tmp_path: Path, clean_db,
) -> None:
    home = tmp_path / "home"
    jsonl = _write_transcript(home, plan_file_path=None)  # older Claude shape

    proc = await _save_agentic_process(_SAMPLE_SESSION_ID)

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False),
    )

    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert proc_reloaded.private_context_entities_ == []


# ── end-to-end FSIndexer freshness tests ───────────────────────────────────


def _build_fsindexer(home: Path, ti: TranscriptIndexer) -> FSIndexer:
    idx = FSIndexer(
        roots=[FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    idx.add_function(RecordType.CLAUDE_SESSION, ti)
    return idx


class _CountingHandler:
    match_kind: ClassVar[EntryKind | None] = EntryKind.TOOL_USE
    match_tool_name: ClassVar[str | None] = "ExitPlanMode"

    def __init__(self) -> None:
        self.count = 0

    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None:
        self.count += 1


@pytest.mark.asyncio
async def test_indexer_freshness_skip_avoids_redispatch(
    tmp_path: Path, clean_db,
) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)
    _write_transcript(home, plan_file_path=str(plan_md))

    counter = _CountingHandler()
    ti = TranscriptIndexer()
    ti.add_handler(counter)
    idx = _build_fsindexer(home, ti)

    await idx.index(IndexerOptions(verbose=False))
    first = counter.count
    assert first == 1, f"first pass should fire once, got {first}"

    await idx.index(IndexerOptions(verbose=False))
    assert counter.count == first, (
        "second pass should be skipped by freshness check "
        f"(count={counter.count}, expected {first})"
    )


@pytest.mark.asyncio
async def test_indexer_force_redispatches(tmp_path: Path, clean_db) -> None:
    home = tmp_path / "home"
    plan_md = _write_plan_md(home)
    _write_transcript(home, plan_file_path=str(plan_md))

    counter = _CountingHandler()
    ti = TranscriptIndexer()
    ti.add_handler(counter)
    idx = _build_fsindexer(home, ti)

    await idx.index(IndexerOptions(verbose=False))
    assert counter.count == 1

    await idx.index(IndexerOptions(verbose=False, force=True))
    assert counter.count == 2, (
        f"force=True should re-fire the handler (count={counter.count})"
    )
