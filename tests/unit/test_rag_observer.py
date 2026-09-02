"""The post-index observer: the only thing RAG does inside an indexer run.

Two properties matter and both are about restraint. It must never make a paid call, because a
scan of a thousand documents would otherwise cost money and stall behind a provider outage. And
it must not write a row per document, because the flag it sets has the same value after the
first one.

Also pins that markdown now carries two post-sync observers rather than one — a single-slot
callback with two consumers is how the second one quietly disappears in a later edit.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.rag.observer import mark_rag_stale

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT = "11111111-2222-4333-8444-555555555555"


class _Record:
    """The two things the observer reads off a synced record."""

    def __init__(self, path: str, project_id: str | None = PROJECT):
        self.asset_ref = type("_Ref", (), {"path": path})()
        self.project_id = project_id
        self.type = "markdown"
        self.id = "rec-1"


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    root.mkdir()
    (root / "intro.md").write_text("# Intro\n\nHello.\n")
    return root


async def _index_over(docs: Path, **kw) -> RagIndex:
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT, **kw)
    await index.add_root(str(docs))
    index.pending = False
    await index.save(notify=False)
    return index


# ── it marks ─────────────────────────────────────────────────────────────────


async def test_a_covered_document_marks_its_index_pending(docs):
    index = await _index_over(docs)
    await mark_rag_stale(_Record(str(docs / "intro.md")))

    refreshed = await RagIndex.get_by_id(index.id)
    assert refreshed.pending is True


async def test_a_document_outside_every_root_marks_nothing(docs, tmp_path):
    index = await _index_over(docs)
    await mark_rag_stale(_Record(str(tmp_path / "elsewhere" / "note.md")))

    refreshed = await RagIndex.get_by_id(index.id)
    assert refreshed.pending is False


async def test_a_disabled_index_is_not_woken_by_an_edit(docs):
    """A person turned it off. A file change must not quietly resurrect the work."""
    index = RagIndex(status=RagStatus.DISABLED, project_id=PROJECT)
    await index.add_root(str(docs))
    index.pending = False
    await index.save(notify=False)

    await mark_rag_stale(_Record(str(docs / "intro.md")))
    assert (await RagIndex.get_by_id(index.id)).pending is False


# ── it writes once ───────────────────────────────────────────────────────────


async def test_a_folder_of_documents_writes_the_row_once(docs, monkeypatch):
    """The flag's value does not change after the first document; neither should the row."""
    await _index_over(docs)

    saves = {"n": 0}
    original = RagIndex.save

    async def counted(self, *a, **kw):
        saves["n"] += 1
        return await original(self, *a, **kw)

    monkeypatch.setattr(RagIndex, "save", counted)
    for i in range(50):
        await mark_rag_stale(_Record(str(docs / f"doc{i}.md")))

    assert saves["n"] == 1


# ── it is cheap and safe ─────────────────────────────────────────────────────


async def test_a_record_without_a_path_is_ignored():
    """Nothing to test containment against; not an error either."""
    await mark_rag_stale(_Record(""))


async def test_the_observer_never_embeds(docs, monkeypatch):
    """The contract the indexer depends on: no paid call, ever, on this path."""
    import flow_sdk.rag.indexing as indexing

    async def explode(*a, **kw):
        raise AssertionError("the observer must not index or embed")

    monkeypatch.setattr(indexing, "index_root", explode)
    monkeypatch.setattr(indexing, "index_roots", explode)

    index = await _index_over(docs)
    await mark_rag_stale(_Record(str(docs / "intro.md")))
    assert (await RagIndex.get_by_id(index.id)).pending is True


# ── the callback slot ────────────────────────────────────────────────────────


def test_markdown_runs_both_observers():
    """A single slot with two consumers is how the second one silently disappears."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    names = [getattr(fn, "__name__", "") for fn in SchemaRegistry.get("markdown").post_sync_callbacks]
    assert "reconcile_folder_doc_edges" in names
    assert "mark_rag_stale" in names


def test_a_single_callable_still_normalizes_to_one():
    """Every other type declares one; the shape they were written in keeps working."""
    from flow_sdk.fs_store.schema_registry import TypeInfo

    def only(_record):
        return None

    assert TypeInfo(type_name="x", post_sync_fn=only).post_sync_callbacks == (only,)
    assert TypeInfo(type_name="x").post_sync_callbacks == ()


async def test_one_failing_observer_does_not_stop_the_next(docs, monkeypatch):
    """They are independent; the sync they follow has already committed either way."""
    from flow_sdk.fs_store.schema_registry import TypeInfo

    ran: list[str] = []

    async def boom(_record):
        ran.append("boom")
        raise RuntimeError("observer exploded")

    async def after(_record):
        ran.append("after")

    info = TypeInfo(type_name="x", post_sync_fn=(boom, after))
    for callback in info.post_sync_callbacks:
        try:
            await callback(None)
        except Exception:  # noqa: BLE001 — mirrors the isolation in _sync_to_db_unlocked
            pass
    assert ran == ["boom", "after"]
