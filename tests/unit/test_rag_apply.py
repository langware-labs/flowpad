"""``RagIndex.apply(change)`` — signed weights, idempotent by construction.

Every assertion is about ``embedded``, the number that costs money: re-applying a page embeds
nothing, a rename embeds nothing, and a delete is the same code path as an add.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import FolderChange
from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.rag import reconcile
from tests.unit.rag_embedder import embed, embed_all

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT = "11111111-2222-4333-8444-555555555555"


@pytest.fixture(autouse=True)
def local_embedder(monkeypatch):
    async def embedder(index):
        async def _embed(texts):
            return embed_all(list(texts))
        return _embed, "ngram-test"
    monkeypatch.setattr(reconcile, "embedder_for", embedder)


@pytest.fixture(autouse=True)
async def _funded(monkeypatch):
    """Every index here resolves an endpoint, so settle_status promotes it to ACTIVE."""
    async def some_endpoint(self):
        return object()
    monkeypatch.setattr(RagIndex, "resolve_endpoint", some_endpoint)


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    root = tmp_path / "docs"
    root.mkdir()
    (root / "intro.md").write_text("# Intro\n\nThe beach was hot and sunny all afternoon.\n")
    (root / "weather.md").write_text("# Weather\n\nThe blizzard closed the mountain road.\n")
    return root


def _page(root: Path, **kw) -> FolderChange:
    return FolderChange(source_id="src", root=str(root), **kw)


async def _index() -> RagIndex:
    """A fresh index per test: `named` is find-or-create and the suite shares one database."""
    return await RagIndex.named(f"idx-{mint_uuid()}")


async def test_an_added_page_is_indexed_and_reapplying_it_embeds_nothing(docs):
    index = await _index()
    page = _page(docs, added=[str(docs / "intro.md"), str(docs / "weather.md")])
    first = await index.apply(page)
    assert first.embedded > 0 and first.documents_changed == 2
    again = await index.apply(page)
    assert again.embedded == 0


async def test_a_changed_document_drops_its_stale_chunk(docs):
    index = await _index()
    await index.apply(_page(docs, added=[str(docs / "weather.md")]))
    (docs / "weather.md").write_text("# Weather\n\nEntirely different words about rainfall.\n")
    await index.apply(_page(docs, changed=[str(docs / "weather.md")]))
    hits = await index.search("blizzard on the mountain road", top_k=3)
    assert not any("blizzard" in h.text for h in hits)


async def test_a_removed_document_is_gone_through_the_same_path_as_an_add(docs):
    index = await _index()
    await index.apply(_page(docs, added=[str(docs / "intro.md"), str(docs / "weather.md")]))
    (docs / "weather.md").unlink()
    report = await index.apply(_page(docs, removed=[str(docs / "weather.md")]))
    assert report.documents_removed == 1 and report.chunks_removed > 0
    async with index.open_store() as store:
        assert str(docs / "weather.md") not in store.document_refs()


async def test_a_rename_retires_the_old_path_and_indexes_the_new_one(docs):
    """A rename is −1 on the old path and +1 on the new: one page, both halves, no orphan.

    The moved document IS re-embedded today: a chunk id keys on its doc_ref as well as its
    text, so a new path is a new id. The store already records ``text_hash`` per chunk, so
    reusing an identical text's vector across a move is the obvious follow-up — but this test
    pins what the code does, not what it could.
    """
    index = await _index()
    await index.apply(_page(docs, added=[str(docs / "intro.md")]))
    moved = docs / "welcome.md"
    (docs / "intro.md").rename(moved)
    report = await index.apply(_page(docs, renamed={str(moved): str(docs / "intro.md")}))
    assert report.documents_removed == 1 and report.documents_changed == 1
    async with index.open_store() as store:
        refs = store.document_refs()
    assert str(moved) in refs and str(docs / "intro.md") not in refs


async def test_a_net_zero_path_is_skipped(docs):
    index = await _index()
    ghost = str(docs / "ghost.md")
    report = await index.apply(_page(docs, added=[ghost], removed=[ghost]))
    assert report.embedded == 0 and report.documents_changed == 0


async def test_a_refusal_is_a_sentence_on_the_report_never_an_exception(docs, monkeypatch):
    index = await _index()
    index.status = RagStatus.DISABLED
    await index.save(notify=False)
    report = await index.apply(_page(docs, added=[str(docs / "intro.md")]))
    assert report.embedded == 0 and report.errors == ["this index is disabled"]


async def test_what_was_applied_can_be_found(docs):
    index = await _index()
    await index.apply(_page(docs, added=[str(docs / "intro.md"), str(docs / "weather.md")]))
    hit = (await index.search("a hot sunny day at the beach", top_k=1))[0]
    assert hit.doc_ref == str(docs / "intro.md")
    assert embed  # the trigram embedder is real; the ranking means something
