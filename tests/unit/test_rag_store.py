"""The vector store, exercised with a real embedder rather than fixed vectors.

The point of the real embedder (``tests/unit/rag_embedder.py``) is that these tests can assert
*ranking*. A store that returned its results backwards, or that lost the mapping from a usearch
integer key to the document it came from, would pass any test built on stub vectors and fail
here.
"""

from __future__ import annotations

import pytest

from flow_sdk.rag.chunking import chunk_markdown
from flow_sdk.rag.store import INDEX_FILE, DimensionMismatch, RagStore
from flow_sdk.schema.data_spec.rag_spec import RagChunk
from tests.unit.rag_embedder import DIMENSIONS, embed, embed_all

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


SUMMER = "The beach was hot and sunny all afternoon and we swam in the warm sea."
MORE_SUMMER = "We spent the whole warm afternoon swimming in the sunny sea at the beach."
WINTER = "The blizzard closed the mountain road and the snow drifted against the door."


def _chunk(doc_ref: str, text: str, *, heading=None) -> RagChunk:
    path = heading or []
    return RagChunk(
        chunk_id=RagChunk.make_id(doc_ref, path, text),
        doc_ref=doc_ref,
        doc_hash="h1",
        heading_path=path,
        text=text,
        text_hash=RagChunk.make_text_hash(text),
    )


def _store(tmp_path) -> RagStore:
    return RagStore(tmp_path / "store")


def _seed(store: RagStore, pairs: list[tuple[str, str]]) -> int:
    chunks = [_chunk(ref, text) for ref, text in pairs]
    return store.add(chunks, embed_all([c.text for c in chunks]), model="ngram-test")


# ── retrieval actually ranks ─────────────────────────────────────────────────


def test_a_query_ranks_like_with_like(tmp_path):
    """The assertion the whole index exists to satisfy."""
    with _store(tmp_path) as store:
        _seed(store, [("summer.md", SUMMER), ("winter.md", WINTER)])
        hits = store.search(embed("a hot sunny day at the sea"), top_k=2)
        assert [h.doc_ref for h in hits][0] == "summer.md"
        assert hits[0].score > hits[1].score


def test_two_related_documents_both_outrank_an_unrelated_one(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER), ("b.md", MORE_SUMMER), ("c.md", WINTER)])
        hits = store.search(embed("swimming in the warm sea"), top_k=3)
        assert {h.doc_ref for h in hits[:2]} == {"a.md", "b.md"}
        assert hits[-1].doc_ref == "c.md"


def test_a_hit_carries_what_a_citation_needs(tmp_path):
    with _store(tmp_path) as store:
        chunk = _chunk("auth.md", SUMMER, heading=["Auth", "Tokens"])
        store.add([chunk], [embed(chunk.text)], model="ngram-test")
        hit = store.search(embed(SUMMER), top_k=1)[0]
        assert (hit.doc_ref, hit.heading_path) == ("auth.md", ["Auth", "Tokens"])
        assert hit.chunk_id == chunk.chunk_id
        assert hit.text == SUMMER


def test_top_k_bounds_the_answer(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [(f"d{i}.md", f"{SUMMER} number {i}") for i in range(10)])
        assert len(store.search(embed(SUMMER), top_k=3)) == 3


def test_an_empty_store_answers_nothing_rather_than_raising(tmp_path):
    with _store(tmp_path) as store:
        assert store.search(embed("anything"), top_k=5) == []


# ── incremental behaviour ────────────────────────────────────────────────────


def test_adding_the_same_chunks_twice_adds_nothing(tmp_path):
    """The no-op re-index. An id that exists describes text that has not changed."""
    with _store(tmp_path) as store:
        pairs = [("a.md", SUMMER), ("b.md", WINTER)]
        assert _seed(store, pairs) == 2
        assert _seed(store, pairs) == 0
        assert store.chunk_count() == 2


def test_only_the_changed_chunk_is_added(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER), ("b.md", WINTER)])
        added = _seed(store, [("a.md", SUMMER), ("b.md", "The blizzard closed the pass entirely.")])
        assert added == 1
        assert store.chunk_count() == 3  # the old b.md chunk is still there until removed


def test_removing_a_document_takes_its_chunks_and_leaves_the_rest(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER), ("b.md", WINTER)])
        assert store.remove_document("b.md") == 1
        assert store.document_refs() == {"a.md"}
        assert [h.doc_ref for h in store.search(embed(WINTER), top_k=5)] == ["a.md"]


def test_removing_an_unknown_document_is_a_no_op(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER)])
        assert store.remove_document("nope.md") == 0
        assert store.chunk_count() == 1


def test_prune_drops_documents_no_longer_in_the_corpus(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER), ("b.md", WINTER), ("c.md", MORE_SUMMER)])
        assert store.prune_to({"a.md"}) == 2
        assert store.document_refs() == {"a.md"}


def test_document_hashes_report_what_was_last_indexed(tmp_path):
    """How a caller skips a whole file without chunking it."""
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER)])
        assert store.document_hashes() == {"a.md": "h1"}


# ── persistence ──────────────────────────────────────────────────────────────


def test_the_store_survives_a_reopen(tmp_path):
    """Both halves: usearch reloads its vectors and sqlite still resolves the keys."""
    with _store(tmp_path) as store:
        _seed(store, [("summer.md", SUMMER), ("winter.md", WINTER)])
        before = store.search(embed(SUMMER), top_k=2)

    with _store(tmp_path) as reopened:
        assert reopened.chunk_count() == 2
        assert reopened.dimensions == DIMENSIONS
        assert reopened.model == "ngram-test"
        after = reopened.search(embed(SUMMER), top_k=2)
    assert [h.doc_ref for h in after] == [h.doc_ref for h in before]
    assert [round(h.score, 6) for h in after] == [round(h.score, 6) for h in before]


def test_a_mid_build_flush_persists_without_closing(tmp_path):
    """Saving is a whole-file rewrite, so ``add`` no longer does it. A long build flushes
    when it chooses to; ``close`` covers everyone else."""
    store = _store(tmp_path)
    _seed(store, [("a.md", SUMMER)])
    store.flush()
    with _store(tmp_path) as other:
        assert other.chunk_count() == 1
    store.close()


def test_the_tree_hash_round_trips(tmp_path):
    with _store(tmp_path) as store:
        assert store.tree_hash() == ""
        store.stamp(tree_hash="merkle-1")
    with _store(tmp_path) as reopened:
        assert reopened.tree_hash() == "merkle-1"


def test_roots_go_stale_independently(tmp_path):
    """One index covers several folders; editing under one must not re-walk the others."""
    with _store(tmp_path) as store:
        store.stamp(tree_hash="a1", root="/docs")
        store.stamp(tree_hash="b1", root="/notes")
        assert (store.tree_hash("/docs"), store.tree_hash("/notes")) == ("a1", "b1")
        store.stamp(tree_hash="a2", root="/docs")
        assert store.tree_hash("/notes") == "b1"


def test_forgetting_a_root_makes_it_index_from_scratch(tmp_path):
    with _store(tmp_path) as store:
        store.stamp(tree_hash="a1", root="/docs")
        store.forget_tree("/docs")
        assert store.tree_hash("/docs") == ""


# ── the dimension contract ───────────────────────────────────────────────────


def test_a_different_width_is_refused_rather_than_mixed(tmp_path):
    """Two widths are two spaces. Mixing them is silently meaningless, so it is loud instead."""
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER)])
        chunk = _chunk("b.md", WINTER)
        with pytest.raises(DimensionMismatch, match="rebuild"):
            store.add([chunk], [[0.1] * (DIMENSIONS + 1)])


def test_querying_with_the_wrong_width_is_refused(tmp_path):
    with _store(tmp_path) as store:
        _seed(store, [("a.md", SUMMER)])
        with pytest.raises(DimensionMismatch):
            store.search([0.1] * 8, top_k=1)


def test_a_ragged_batch_is_refused(tmp_path):
    with _store(tmp_path) as store:
        chunks = [_chunk("a.md", SUMMER), _chunk("b.md", WINTER)]
        with pytest.raises(DimensionMismatch, match="mixes"):
            store.add(chunks, [[0.1] * DIMENSIONS, [0.1] * 4])


def test_a_mismatched_count_is_refused(tmp_path):
    with _store(tmp_path) as store:
        with pytest.raises(ValueError, match="chunks but"):
            store.add([_chunk("a.md", SUMMER)], [])


# ── end to end with the chunker ──────────────────────────────────────────────


def test_a_chunked_document_is_searchable_by_its_heading(tmp_path):
    doc = (
        "# Deployment\n\nHow we ship.\n\n"
        "## Rollback\n\nTo roll back a release, revert the tag and redeploy the previous build.\n\n"
        "## Monitoring\n\nDashboards live in the ops project and alert on error rate.\n"
    )
    chunks = chunk_markdown(doc, doc_ref="deploy.md", doc_hash="h1", min_tokens=1)
    with _store(tmp_path) as store:
        store.add(chunks, embed_all([c.text for c in chunks]), model="ngram-test")
        hit = store.search(embed("how do I revert a release"), top_k=1)[0]
        assert hit.heading_path == ["Deployment", "Rollback"]


# ── the width-less index ─────────────────────────────────────────────────────


def test_opening_a_store_to_read_a_count_writes_no_index_file(tmp_path):
    """A store opened before anything was embedded must leave no vector index behind.

    Reading a count opens a handle whose width is still unknown. Saving that leaves a
    zero-dimension file on disk, and the next real add loads it and hands 1536-float vectors to
    a metric expecting none — usearch does not raise there, it segfaults and takes the backend
    with it. That is how a coverage edit killed a running instance.
    """
    with RagStore(tmp_path / "store") as store:
        assert store.chunk_count() == 0
        assert store.document_refs() == set()
    assert not (tmp_path / "store" / INDEX_FILE).exists()


def test_a_store_reopened_after_a_bare_read_still_takes_its_first_vectors(tmp_path):
    """The sequence that crashed, end to end: read, close, then embed."""
    with RagStore(tmp_path / "store") as store:
        store.chunk_count()

    with RagStore(tmp_path / "store") as store:
        chunk = _chunk("doc.md", "hello there")
        assert store.add([chunk], [[0.1, 0.2, 0.3, 0.4]], model="m") == 1
        assert store.dimensions == 4

    with RagStore(tmp_path / "store") as store:
        assert store.chunk_count() == 1
        assert store.search([0.1, 0.2, 0.3, 0.4], top_k=1)[0].doc_ref == "doc.md"
