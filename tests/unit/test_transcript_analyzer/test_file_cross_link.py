"""Markdown file → process cross-link via the generic primitives:
``Entity.get_by_asset_ref`` (resolution) + ``cross_link_entities`` (linking).
Live in-memory AP, real DB round-trips, no mocks.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.core.entity.cross_link import cross_link_entities
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.flowpad_types.enums import WorkerType


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
async def test_resolve_returns_none_when_no_markdown_entity(initialize_test_db) -> None:
    assert await Entity.get_by_asset_ref("/some/missing/file.md") is None


@pytest.mark.asyncio
async def test_resolve_then_cross_link_succeeds(initialize_test_db) -> None:
    """Pre-existing Docs + live AP → resolve by asset_ref, bidirectional link."""
    asset = "/tmp/cross_link_test_2.md"
    docs = await _save_docs(asset)
    ap = await _save_ap()

    md = await Entity.get_by_asset_ref(asset)
    assert md is not None and md.id == docs.id

    changed = await cross_link_entities(md, ap, b_data={"path": asset})
    assert changed is True

    # In-memory AP carries the link immediately.
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

    md = await Entity.get_by_asset_ref(asset)
    assert await cross_link_entities(md, ap, b_data={"path": asset}) is True
    assert await cross_link_entities(md, ap, b_data={"path": asset}) is False

    docs_reloaded = await Docs.get_by_id(docs.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert sum(1 for t in docs_reloaded.private_context_entities_ if t.id == ap.id) == 1
    assert sum(1 for t in ap_reloaded.private_context_entities_ if t.id == docs.id) == 1


@pytest.mark.asyncio
async def test_resolve_skips_unknown_path(initialize_test_db) -> None:
    """A path with no entity (e.g. a non-indexed source file) resolves to None."""
    assert await Entity.get_by_asset_ref("/tmp/foo.py") is None
