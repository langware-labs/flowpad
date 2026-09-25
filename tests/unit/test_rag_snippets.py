"""``docs/snippets/rag.md``, run as written — the page's fences in order, one reader's session.

The shelf's rule is that a snippet cannot drift silently, and a snippet nobody executes drifts the moment
a signature moves. Running the page in order caught what a transcription hid: its second fence removed
the folder it had just added, so the pass in §2 had nothing to index. The embedding endpoint and the
embedder are the only things supplied here — a box with a key has both.
"""

import pytest

from flow_sdk.builtin.rag_index import RagIndex, RagStatus
from flow_sdk.rag import reconcile
from tests.unit.rag_embedder import embed_all
from tests.utils.snippets import doc, fence_under, run_fence

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


@pytest.fixture(autouse=True)
def _funded(monkeypatch):
    """An embedding endpoint resolves, as it does on a box with a key: ``settle_status`` promotes."""
    async def endpoint(self):
        return object()
    monkeypatch.setattr(RagIndex, "resolve_endpoint", endpoint)


async def _fence(heading: str, ns: dict, nth: int = 0) -> dict:
    return await run_fence(fence_under(doc("rag.md"), heading, nth=nth), ns, filename=f"rag.md {heading}#{nth}")


async def test_the_page_runs_in_order(notes, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    ns = await _fence("1.", {"NOTES": str(notes)})
    assert ns["covered"] is False, "toggled on, then off"
    ns = await _fence("1.", ns, nth=1)
    assert ns["index"].roots == [str(notes)]

    ns = await _fence("2.", ns)                   # asserts inside: the second pass is fresh
    assert ns["refusal"] == "" and ns["index"].status == RagStatus.ACTIVE

    ns = await _fence("3.", ns)
    assert ns["hit"].doc_ref.endswith("walk.md") and isinstance(ns["hit"].heading_path, list)

    ns = await _fence("4.", {**ns, "DOC": str(notes / "walk.md")})
    assert (tmp_path / "my-store").exists() and ns["chunks"][0].heading_path
