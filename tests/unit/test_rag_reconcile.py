"""The background pass, and the loop it closes with the observer.

The interesting assertions are about the split: the tick selects and spawns but never embeds,
and the flag is cleared *before* the work so an edit arriving mid-pass is caught next time
rather than swallowed. The last test drives the whole loop — edit a file, mark, dispatch, embed,
find it — with a real embedder and no network.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio

from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.rag import reconcile
from flow_sdk.rag.observer import mark_rag_stale
from tests.unit.rag_embedder import embed, embed_all

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT = "11111111-2222-4333-8444-555555555555"


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    root.mkdir()
    (root / "intro.md").write_text("# Intro\n\nThe beach was hot and sunny all afternoon.\n")
    (root / "weather.md").write_text("# Weather\n\nThe blizzard closed the mountain road.\n")
    return root


@pytest.fixture(autouse=True)
def _clean_inflight():
    reconcile._inflight.clear()
    yield
    reconcile._inflight.clear()


@pytest_asyncio.fixture(autouse=True)
async def _no_leftover_indexes():
    """Start every test with no RagIndex rows.

    `dispatch_due_indexes()` answers for the whole box, so these tests can only
    assert "exactly this index was dispatched" if no earlier test left one
    behind. Alone the file passes; in the full suite a neighbour's row made the
    dispatch list someone else's.
    """
    async def _purge() -> None:
        for row in await RagIndex.get_all({}):
            await row.delete()

    await _purge()
    yield
    await _purge()


@pytest.fixture
def local_embedder(monkeypatch):
    """Stand in for the provider at the funding seam, not inside the logic."""

    async def embedder(index):
        async def _embed(texts):
            return embed_all(list(texts))

        return _embed, "ngram-test"

    monkeypatch.setattr(reconcile, "embedder_for", embedder)


async def _active(docs: Path, *, pending: bool = True) -> RagIndex:
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT)
    await index.add_root(str(docs))
    index.pending = pending
    await index.save(notify=False)
    return index


# ── what the tick does, and does not ─────────────────────────────────────────


async def test_the_tick_does_not_embed(docs, monkeypatch):
    """It selects and spawns. Embedding in the tick would block every other heartbeat task."""

    async def explode(*a, **kw):
        raise AssertionError("the tick must not run the pass itself")

    monkeypatch.setattr(reconcile, "_run_guarded", explode)
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = await _active(docs)
    assert await reconcile.dispatch_due_indexes() == [str(index.id)]


async def test_an_unmarked_index_is_not_dispatched(docs, monkeypatch):
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    await _active(docs, pending=False)
    assert await reconcile.dispatch_due_indexes() == []


async def test_a_disabled_index_is_never_dispatched(docs, monkeypatch):
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = RagIndex(status=RagStatus.DISABLED, project_id=PROJECT, pending=True)
    await index.add_root(str(docs))
    await index.save(notify=False)
    assert await reconcile.dispatch_due_indexes() == []


async def test_an_index_already_running_is_not_dispatched_twice(docs, monkeypatch):
    """They share a store and a usearch handle; two passes would contend for one file."""
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = await _active(docs)
    reconcile._inflight.add(str(index.id))
    assert await reconcile.dispatch_due_indexes() == []


async def test_the_flag_is_cleared_before_the_work_not_after(docs, monkeypatch):
    """An edit arriving mid-pass must re-mark the index, not be swallowed by a late clear."""
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = await _active(docs)
    await reconcile.dispatch_due_indexes()
    assert (await RagIndex.get_by_id(index.id)).pending is False


# ── what the pass does ───────────────────────────────────────────────────────


async def test_a_pass_indexes_every_root_and_records_the_counts(docs, local_embedder):
    index = await _active(docs)
    reports = await reconcile.run_index(index)

    assert len(reports) == 1 and reports[0].documents_changed == 2
    assert index.chunk_count > 0 and index.document_count == 2
    assert index.last_indexed_at is not None
    assert index.model == "ngram-test" and index.dimensions > 0


async def test_a_second_pass_over_an_untouched_tree_embeds_nothing(docs, local_embedder):
    index = await _active(docs)
    await reconcile.run_index(index)
    reports = await reconcile.run_index(index)
    assert reports[0].fresh is True and reports[0].embedded == 0


async def test_a_refused_index_does_no_work_and_says_why(docs, local_embedder):
    """No roots: the refusal is the sentence, and the pass is a no-op."""
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT, pending=True)
    await index.save(notify=False)
    assert await reconcile.run_index(index) == []
    assert index.index_refusal() == "this index covers no folders yet"


async def test_no_endpoint_leaves_the_reason_on_the_row(docs, monkeypatch):
    """A person reads this on the card; it must not be a traceback in a log."""

    async def nothing(index):
        return None, ""

    monkeypatch.setattr(reconcile, "embedder_for", nothing)
    index = await _active(docs)
    assert await reconcile.run_index(index) == []
    assert "no embedding endpoint" in index.last_error


async def test_a_provider_failure_is_recorded_rather_than_raised(docs, monkeypatch):
    """The next tick tries again; a raise here would kill the task and say nothing."""

    async def broken(index):
        async def _embed(texts):
            raise RuntimeError("the provider returned 503")

        return _embed, "ngram-test"

    monkeypatch.setattr(reconcile, "embedder_for", broken)
    index = await _active(docs)
    await reconcile.run_index(index)
    assert "503" in index.last_error


# ── the whole loop ───────────────────────────────────────────────────────────


async def test_editing_a_file_marks_dispatches_embeds_and_becomes_findable(docs, local_embedder):
    """The end-to-end shape: the observer marks, the pass embeds, the store answers."""
    index = await _active(docs, pending=False)
    await reconcile.run_index(index)

    (docs / "extra.md").write_text(
        "# Gardening\n\nTomatoes ripen best when the greenhouse stays humid and warm.\n"
    )

    class _Record:
        asset_ref = type("_Ref", (), {"path": str(docs / "extra.md")})()
        project_id = PROJECT
        type = "markdown"
        id = "rec-1"

    await mark_rag_stale(_Record())
    assert (await RagIndex.get_by_id(index.id)).pending is True

    refreshed = await RagIndex.get_by_id(index.id)
    reports = await reconcile.run_index(refreshed)
    assert reports[0].documents_changed == 1

    async with refreshed.open_store() as store:
        hit = store.search(embed("ripening tomatoes in a humid greenhouse"), top_k=1)[0]
    assert hit.doc_ref == str(docs / "extra.md")


# ── settling out of SETUP ────────────────────────────────────────────────────


async def test_an_index_minted_before_any_key_is_promoted_once_one_appears(docs, monkeypatch):
    """Otherwise SETUP is a trap: the dispatcher skips it, so nothing ever looks again."""
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = RagIndex(status=RagStatus.SETUP, project_id=PROJECT, pending=True)
    await index.add_root(str(docs))
    await index.save(notify=False)

    monkeypatch.setattr(RagIndex, "resolve_endpoint", lambda self: _some_endpoint())
    assert await reconcile.dispatch_due_indexes() == [str(index.id)]
    assert (await RagIndex.get_by_id(index.id)).status == RagStatus.ACTIVE


async def test_an_index_with_nothing_funding_it_stays_in_setup_and_says_why(docs, monkeypatch):
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    # "Nothing funds it" is asserted by CONSTRUCTION, not by hoping the shared
    # session DB holds no endpoint: `tests/conftest.py` opens one SQLite file for
    # the whole run, so an endpoint another test saved would promote this index
    # out of SETUP and dispatch it. The sibling below pins the opposite way.
    async def _unfunded(self):
        return None

    monkeypatch.setattr(RagIndex, "resolve_endpoint", _unfunded)
    index = RagIndex(status=RagStatus.SETUP, project_id=PROJECT, pending=True)
    await index.add_root(str(docs))
    await index.save(notify=False)

    assert await reconcile.dispatch_due_indexes() == []
    refreshed = await RagIndex.get_by_id(index.id)
    assert refreshed.status == RagStatus.SETUP
    assert "no embedding endpoint" in refreshed.last_error


async def test_a_disabled_index_is_never_promoted(docs, monkeypatch):
    """DISABLED is a person's decision; finding a key is not a reason to overrule it."""
    monkeypatch.setattr(RagIndex, "resolve_endpoint", lambda self: _some_endpoint())
    index = RagIndex(status=RagStatus.DISABLED, project_id=PROJECT, pending=True)
    await index.add_root(str(docs))
    await index.save(notify=False)

    assert await index.settle_status() == "this index is disabled"
    assert index.status == RagStatus.DISABLED


async def _some_endpoint():
    """Anything not-None: settling asks whether funding EXISTS, never what it is."""
    return object()
