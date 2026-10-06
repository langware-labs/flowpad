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
from flow_sdk.rag.store import ModelMismatch
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


async def test_an_index_with_nothing_to_do_is_not_dispatched(docs, monkeypatch, local_embedder):
    """Nothing marked AND every root already stamped — the quiet case, which is most ticks."""
    index = await _active(docs)
    await reconcile.run_index(index)
    # The PASS does not clear the mark — the dispatcher does, before it spawns. Clear it here
    # so this test is about "nothing to do", not about who owns the flag.
    index.pending = False
    await index.save(notify=False)

    monkeypatch.setattr(reconcile, "_spawn", lambda i: None)
    assert await index.unstamped_roots() == []
    assert await reconcile.dispatch_due_indexes() == []


async def test_a_root_the_store_has_no_hash_for_is_dispatched_unmarked(docs, monkeypatch):
    """The case no marker can announce: the vectors are gone, so nothing is left to mark it.

    A store deleted, moved, or never built leaves the row still claiming it was indexed. Without
    this the index sits there looking healthy and answering nothing, forever.
    """
    monkeypatch.setattr(reconcile, "_spawn", lambda index: None)
    index = await _active(docs, pending=False)

    assert await index.unstamped_roots() == index.roots
    assert await reconcile.dispatch_due_indexes() == [str(index.id)]


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
        raise reconcile.EmbeddingUnavailable()

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

    (docs / "extra.md").write_text("# Gardening\n\nTomatoes ripen best when the greenhouse stays humid and warm.\n")

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


# ── who funds the embeddings ─────────────────────────────────────────────────

HUB_OPENROUTER = "aaaaaaaa-1111-4111-8111-111111111111"
HUB_ANTHROPIC = "bbbbbbbb-2222-4222-8222-222222222222"
LOCAL_ID = "cccccccc-3333-4333-8333-333333333333"


@pytest.fixture
def funding(monkeypatch):
    """The funding seams, set per test: local rows, hub rows, and whether this box is signed in.

    The local rows are pinned rather than read from the shared session DB, which other tests
    write endpoints into; the hub list is what ``fetch_hub_llm_endpoints`` would have answered.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    state: dict = {"local": {}, "hub": [], "signed_in": True}

    async def _key_endpoints(cls):
        return {row.secret_name: row for row in state["local"].values()}

    async def _get_by_id(cls, entity_id, *args, **kwargs):
        return state["local"].get(str(entity_id))

    async def _fetch(*, cached_only=False):
        return list(state["hub"]) if state["signed_in"] else []

    monkeypatch.setattr(LLMEndpoint, "key_endpoints", classmethod(_key_endpoints))
    monkeypatch.setattr(LLMEndpoint, "get_by_id", classmethod(_get_by_id))
    monkeypatch.setattr("flow_sdk.instance_settings.llm_endpoint.fetch_hub_llm_endpoints", _fetch)
    monkeypatch.setattr(
        "flow_sdk.cli.auth.hub_login.resolve_hub_api_key",
        lambda *a, **k: "fp-hub-key" if state["signed_in"] else None,
    )
    monkeypatch.setattr(llm_source, "_hub_has_token", lambda: state["signed_in"])
    return state


def _hub(endpoint_id: str, provider: str, *, enabled: bool = True):
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    return LLMEndpoint(id=endpoint_id, name=f"{provider} budget", provider=provider, enabled=enabled)


def _local(provider: str = "openai", *, endpoint_id: str = LOCAL_ID):
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    return LLMEndpoint(id=endpoint_id, kind="api_key", provider=provider, api_key="sk-local")


async def test_a_bound_local_endpoint_wins(funding):
    local = _local()
    funding["local"] = {LOCAL_ID: local}
    funding["hub"] = [_hub(HUB_OPENROUTER, "openrouter")]
    index = RagIndex(project_id=PROJECT, endpoint_typeid=f"llm_endpoint-{LOCAL_ID}")
    assert await index.resolve_endpoint() is local


async def test_a_bound_hub_endpoint_is_the_hubs_row(funding):
    """Not a local projection: that would mint an id the hub does not authorize."""
    hub = _hub(HUB_OPENROUTER, "openrouter")
    funding["local"] = {LOCAL_ID: _local()}
    funding["hub"] = [_hub(HUB_ANTHROPIC, "anthropic"), hub]
    index = RagIndex(project_id=PROJECT, endpoint_typeid=f"llm_endpoint-{HUB_OPENROUTER}")
    assert await index.resolve_endpoint() is hub


async def test_a_local_key_is_preferred_over_an_unbound_hub_budget(funding):
    local = _local()
    funding["local"] = {LOCAL_ID: local}
    funding["hub"] = [_hub(HUB_OPENROUTER, "openrouter")]
    assert await RagIndex(project_id=PROJECT).resolve_endpoint() is local


async def test_with_no_local_key_a_spendable_hub_budget_funds_the_index(funding):
    hub = _hub(HUB_OPENROUTER, "openrouter")
    funding["hub"] = [_hub("dddddddd-4444-4444-8444-444444444444", "openai", enabled=False), hub]
    assert await RagIndex(project_id=PROJECT).resolve_endpoint() is hub


async def test_a_hub_budget_whose_root_cannot_embed_is_skipped(funding):
    """An Anthropic root has no embeddings API; picking it would fail every pass."""
    funding["hub"] = [_hub(HUB_ANTHROPIC, "anthropic")]
    assert await RagIndex(project_id=PROJECT).resolve_endpoint() is None
    hub = _hub(HUB_OPENROUTER, "openrouter")
    funding["hub"] = [_hub(HUB_ANTHROPIC, "anthropic"), hub]
    assert await RagIndex(project_id=PROJECT).resolve_endpoint() is hub


async def test_signed_out_nothing_funds_the_index_and_it_stays_in_setup(docs, funding):
    funding["hub"] = [_hub(HUB_OPENROUTER, "openrouter")]
    funding["signed_in"] = False
    index = RagIndex(status=RagStatus.SETUP, project_id=PROJECT)
    await index.add_root(str(docs))
    await index.save(notify=False)

    assert await index.resolve_endpoint() is None
    assert "no embedding endpoint" in await index.settle_status()
    assert index.status == RagStatus.SETUP


# ── which model an index embeds with ─────────────────────────────────────────


def _answering(model_answered: str, recorder: dict):
    """A hub endpoint whose provider answers with *model_answered*, recording what it was asked."""

    async def create_embeddings_with_model(self, texts, *, model=None, timeout=60.0):
        recorder["model"] = model
        return embed_all(list(texts)), model_answered

    return create_embeddings_with_model


async def test_a_hub_endpoint_pins_the_root_providers_default_model(docs, funding, monkeypatch):
    """A hub row carries no models; the index must still record a concrete one."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    recorder: dict = {}
    monkeypatch.setattr(LLMEndpoint, "create_embeddings_with_model", _answering("text-embedding-3-small", recorder))
    funding["hub"] = [_hub(HUB_OPENROUTER, "openrouter")]
    index = await _active(docs)

    embed_fn, model = await reconcile.embedder_for(index)
    assert model == "openai/text-embedding-3-small"
    assert len(await embed_fn(["a sunny beach"])) == 1
    assert recorder["model"] == "openai/text-embedding-3-small"

    await reconcile.run_index(index)
    assert index.last_error == ""
    assert index.model == "openai/text-embedding-3-small"
    async with index.open_store() as store:
        assert store.model == "openai/text-embedding-3-small"


async def test_a_provider_answering_with_another_model_stores_nothing(docs, funding, monkeypatch):
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    monkeypatch.setattr(LLMEndpoint, "create_embeddings_with_model", _answering("text-embedding-3-large", {}))
    funding["hub"] = [_hub(HUB_OPENROUTER, "openrouter")]
    index = await _active(docs)

    embed_fn, _ = await reconcile.embedder_for(index)
    with pytest.raises(ModelMismatch, match="text-embedding-3-large"):
        await embed_fn(["a sunny beach"])

    await reconcile.run_index(index)
    assert "text-embedding-3-large" in index.last_error
    assert "openai/text-embedding-3-small" in index.last_error
    async with index.open_store() as store:
        assert store.chunk_count() == 0
