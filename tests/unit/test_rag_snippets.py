"""The snippets in ``docs/snippets/rag.md``, run verbatim.

The shelf's rule is that a snippet cannot drift silently, and a snippet nobody executes drifts
the moment a signature moves. Writing this caught two errors in the page as first drafted:
``chunk_markdown`` takes the text positionally and ``doc_ref`` by keyword, and a freshly created
index is SETUP — so the pass it showed would have returned an empty list to anyone who copied it.

Keep each test a transcription of one section. If a snippet changes, change the test with it.
"""

import pytest

from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.rag import reconcile
from flow_sdk.rag.chunking import chunk_markdown
from flow_sdk.rag.store import RagStore
from tests.unit.rag_embedder import embed_all

pytestmark = pytest.mark.timeout(30)


@pytest.fixture
def notes(tmp_path):
    d = tmp_path / "notes"
    d.mkdir()
    (d / "walk.md").write_text("# Walk\n\nThe walker skips ignored directories on the way down.\n")
    return d


@pytest.fixture(autouse=True)
async def _empty_box():
    """``ensure_default`` answers the OLDEST index on the box; the suite shares one database."""
    for status in RagStatus:
        for index in await RagIndex.get_all({"status": status.value}):
            await index.destroy()
    yield


@pytest.fixture(autouse=True)
def _embedder(monkeypatch):
    async def embedder(index):
        async def _e(texts):
            return embed_all(list(texts))
        return _e, "ngram-test"
    monkeypatch.setattr(reconcile, "embedder_for", embedder)


async def test_snippet_1_toggle(notes):
    index, covered = await RagIndex.toggle_root(str(notes))
    assert covered is True
    index, covered = await RagIndex.toggle_root(str(notes))
    assert covered is False

    index = await RagIndex.ensure_default()
    await index.add_root(str(notes))
    assert index.roots == [str(notes)]
    await index.remove_root(str(notes))
    assert index.roots == []


async def test_snippet_2_run_a_pass(notes):
    index = await RagIndex.ensure_default()
    await index.add_root(str(notes))
    index.status = RagStatus.ACTIVE          # a real box promotes via settle_status once a key exists
    await index.save(notify=False)
    reports = await reconcile.run_index(index)
    assert reports and reports[0].embedded > 0
    again = await reconcile.run_index(index)
    assert again[0].fresh and again[0].embedded == 0


async def test_snippet_3_ask(notes):
    index = await RagIndex.ensure_default()
    await index.add_root(str(notes))
    index.status = RagStatus.ACTIVE
    await index.save(notify=False)
    await reconcile.run_index(index)

    embed, model = await reconcile.embedder_for(index)
    vectors = await embed(["which directories does the walker skip"])
    async with index.open_store() as store:
        hits = store.search(vectors[0], top_k=5)
    assert hits and hits[0].doc_ref.endswith("walk.md")
    assert isinstance(hits[0].heading_path, list)


async def test_snippet_4_chunk_and_store(notes, tmp_path):
    doc = notes / "walk.md"
    chunks = chunk_markdown(doc.read_text(), doc_ref=str(doc))
    assert chunks and chunks[0].heading_path

    async def embed(texts):
        return embed_all(list(texts))

    with RagStore(tmp_path / "my-store") as store:
        fresh = store.unknown(chunks)
        assert fresh
        store.add(fresh, await embed([c.text for c in fresh]), model="ngram-test")
        assert store.unknown(chunks) == []
