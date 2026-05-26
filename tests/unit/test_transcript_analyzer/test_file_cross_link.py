"""C4: ``cross_link_file_to_process`` — markdown-only cross-link against the
live in-memory AP. No DB lookup of the AP (avoids the stale-instance overwrite
that would otherwise let subsequent AP saves clobber the link).
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.file_cross_link import cross_link_file_to_process


pytestmark = pytest.mark.timeout(30)


async def _save_docs(asset_ref: str) -> Docs:
    return await Docs(name=Path(asset_ref).name, asset_ref=asset_ref).save()


async def _save_ap(session_id: str | None = None) -> AgenticProcess:
    return await AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=session_id or str(uuid.uuid4()),
        worker_type=WorkerType.CLAUDE_CODE,
    ).save()


def _has_link(entries, type_, id_) -> bool:
    return any(t.type == type_ and t.id == id_ for t in entries)


@pytest.mark.asyncio
async def test_cross_link_returns_none_when_no_markdown_entity(initialize_test_db) -> None:
    """No on-demand reindex per locked decision 3."""
    ap = await _save_ap()
    assert await cross_link_file_to_process("/some/missing/file.md", ap) is None


@pytest.mark.asyncio
async def test_cross_link_succeeds_when_both_sides_exist(initialize_test_db) -> None:
    """Pre-existing Docs + live AP → bidirectional cross-link, both sides persisted."""
    asset = "/tmp/cross_link_test_2.md"
    docs = await _save_docs(asset)
    ap = await _save_ap()

    md_out = await cross_link_file_to_process(asset, ap)
    assert md_out is not None and md_out.id == docs.id

    # In-memory AP carries the link immediately (the production bug we fixed).
    assert _has_link(ap.private_context_entities_, Docs.get_type(), docs.id)

    docs_reloaded = await Docs.get_by_id(docs.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert _has_link(docs_reloaded.private_context_entities_, AgenticProcess.get_type(), ap.id)
    assert _has_link(ap_reloaded.private_context_entities_, Docs.get_type(), docs.id)


@pytest.mark.asyncio
async def test_cross_link_idempotent(initialize_test_db) -> None:
    """Calling twice produces exactly one link in each direction."""
    asset = "/tmp/cross_link_test_3.md"
    docs = await _save_docs(asset)
    ap = await _save_ap()

    await cross_link_file_to_process(asset, ap)
    await cross_link_file_to_process(asset, ap)

    docs_reloaded = await Docs.get_by_id(docs.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert sum(1 for t in docs_reloaded.private_context_entities_ if t.id == ap.id) == 1
    assert sum(1 for t in ap_reloaded.private_context_entities_ if t.id == docs.id) == 1


@pytest.mark.asyncio
async def test_cross_link_skips_non_markdown_path(initialize_test_db) -> None:
    ap = await _save_ap()
    assert await cross_link_file_to_process("/tmp/foo.py", ap) is None


@pytest.mark.asyncio
async def test_cross_link_returns_none_when_ap_missing(initialize_test_db) -> None:
    assert await cross_link_file_to_process("/tmp/anything.md", None) is None
