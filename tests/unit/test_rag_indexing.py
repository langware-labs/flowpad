"""The indexing pass: walk a folder, embed only what changed, and prove it.

Every assertion here is about `embedded` — the number of chunks actually sent to a provider,
which is the number that costs money. A RAG index that re-embeds a whole corpus because one
word changed is not a slow index, it is an expensive one, and that is the failure these tests
are shaped to catch.

The embedder is real (`tests/unit/rag_embedder.py`, normalised character trigrams), so the
retrieval assertion at the end means something. It is injected the same way the doc indexer
injects its summarizers, so nothing in the module under test knows it is in a test.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.rag.indexing import index_root, index_roots
from flow_sdk.rag.store import RagStore
from tests.unit.rag_embedder import embed, embed_all

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


SUMMER = "The beach was hot and sunny all afternoon and we swam in the warm sea."
WINTER = "The blizzard closed the mountain road and the snow drifted against the door."


async def _embed(texts):
    return embed_all(list(texts))


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    (root / "auth").mkdir(parents=True)
    (root / "intro.md").write_text(f"# Intro\n\n{SUMMER}\n")
    (root / "weather.md").write_text(f"# Weather\n\n{WINTER}\n")
    (root / "auth" / "tokens.md").write_text("# Tokens\n\nRefresh tokens rotate on every use.\n")
    return root


@pytest.fixture
def store(tmp_path: Path):
    with RagStore(tmp_path / "store") as s:
        yield s


async def _index(store, root, **kw):
    return await index_root(store, root, embed=_embed, model="ngram-test", **kw)


# ── the first pass ───────────────────────────────────────────────────────────


async def test_a_first_pass_indexes_every_document(store, docs):
    report = await _index(store, docs)
    assert report.documents_seen == 3
    assert report.documents_changed == 3
    assert report.embedded == report.chunks_added > 0
    assert store.document_refs() == {str(p) for p in docs.rglob("*.md")}


async def test_subfolders_are_walked(store, docs):
    await _index(store, docs)
    assert any(r.endswith("auth/tokens.md") for r in store.document_refs())


async def test_the_root_hash_is_recorded(store, docs):
    report = await _index(store, docs)
    assert report.tree_hash and store.tree_hash(str(docs)) == report.tree_hash


# ── the second pass: the whole point ─────────────────────────────────────────


async def test_an_unchanged_tree_embeds_nothing_and_reads_nothing(store, docs):
    """One string comparison against the Merkle root, then done."""
    await _index(store, docs)
    report = await _index(store, docs)
    assert report.fresh is True
    assert (report.embedded, report.documents_seen) == (0, 0)


async def test_editing_one_file_re_embeds_only_that_file(store, docs):
    first = await _index(store, docs)
    (docs / "weather.md").write_text(f"# Weather\n\n{WINTER} It lasted three days.\n")

    second = await _index(store, docs)
    assert second.documents_changed == 1
    assert second.embedded < first.embedded
    assert second.skipped_unchanged == 2


async def test_an_edit_replaces_the_old_text_rather_than_adding_to_it(store, docs):
    """Without dropping the old chunks first, both versions stay searchable forever."""
    await _index(store, docs)
    before = store.chunk_count()
    (docs / "weather.md").write_text("# Weather\n\nEntirely different words about rainfall.\n")

    await _index(store, docs)
    assert store.chunk_count() == before
    assert not any("blizzard" in h.text for h in store.search(embed(WINTER), top_k=5))


async def test_adding_a_file_embeds_only_the_new_one(store, docs):
    first = await _index(store, docs)
    (docs / "extra.md").write_text("# Extra\n\nA brand new document about gardening in spring.\n")

    second = await _index(store, docs)
    assert second.documents_changed == 1
    assert second.embedded < first.embedded
    assert store.document_refs() >= {str(docs / "extra.md")}


async def test_deleting_a_file_removes_its_chunks(store, docs):
    await _index(store, docs)
    (docs / "weather.md").unlink()

    report = await _index(store, docs)
    assert report.documents_removed == 1
    assert report.chunks_removed > 0
    assert str(docs / "weather.md") not in store.document_refs()


async def test_a_moved_section_is_not_re_embedded(store, docs):
    """Chunk ids key on text, so reordering a document costs nothing.

    Both sections are deliberately well over the fold floor. Two short ones would merge into a
    single chunk, and reordering would then genuinely change that chunk's text — a different
    scenario, and one the store is right to charge for.
    """
    a = "# Alpha\n\n" + " ".join(["alpha"] * 120) + "\n"
    b = "# Beta\n\n" + " ".join(["beta"] * 120) + "\n"
    (docs / "ordered.md").write_text(a + "\n" + b)
    await _index(store, docs)

    (docs / "ordered.md").write_text(b + "\n" + a)
    report = await _index(store, docs)
    assert report.documents_changed == 1
    assert report.embedded == 0  # the file changed; not one chunk of it did
    assert report.chunks_removed == 0


# ── force ────────────────────────────────────────────────────────────────────


async def test_force_re_reads_everything_but_still_does_not_re_embed(store, docs):
    """An identical chunk has an identical vector; paying again would buy nothing."""
    await _index(store, docs)
    report = await _index(store, docs, force=True)
    assert report.documents_changed == 3
    assert report.embedded == 0


# ── several roots ────────────────────────────────────────────────────────────


async def test_two_roots_share_one_store_and_go_stale_independently(store, tmp_path, docs):
    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "diary.md").write_text("# Diary\n\nA quiet week with little to report at all.\n")

    await index_roots(store, [str(docs), str(notes)], embed=_embed, model="ngram-test")
    (notes / "diary.md").write_text("# Diary\n\nA busy week with rather a lot to report.\n")

    reports = await index_roots(store, [str(docs), str(notes)], embed=_embed, model="ngram-test")
    by_root = {Path(r.root).name: r for r in reports}
    assert by_root["docs"].fresh is True
    assert by_root["notes"].documents_changed == 1


async def test_deleting_from_one_root_leaves_the_other_alone(store, tmp_path, docs):
    """The prune is scoped to the root being indexed, not the whole store."""
    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "diary.md").write_text("# Diary\n\nA quiet week with little to report at all.\n")
    await index_roots(store, [str(docs), str(notes)], embed=_embed, model="ngram-test")

    (docs / "weather.md").unlink()
    await index_root(store, docs, embed=_embed, model="ngram-test")
    assert str(notes / "diary.md") in store.document_refs()


# ── failure and retrieval ────────────────────────────────────────────────────


async def test_an_unreadable_file_is_reported_and_the_pass_continues(store, docs, monkeypatch):
    """One bad file must not cost the whole folder its index."""
    real = Path.read_text

    def explode(self, *a, **kw):
        if self.name == "weather.md":
            raise OSError("vanished mid-walk")
        return real(self, *a, **kw)

    monkeypatch.setattr(Path, "read_text", explode)
    report = await _index(store, docs)
    assert any("weather.md" in e for e in report.errors)
    assert report.chunks_added > 0


async def test_what_was_indexed_can_actually_be_found(store, docs):
    """The end-to-end assertion: a real embedder, a real store, the right document."""
    await _index(store, docs)
    hit = store.search(embed("a hot sunny day swimming in the sea"), top_k=1)[0]
    assert hit.doc_ref == str(docs / "intro.md")
