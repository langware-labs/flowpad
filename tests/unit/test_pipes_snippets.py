"""The runnable snippets in ``docs/snippets/pipes.md``.

Only sections 1-3. Everything under "Proposed" is a recommendation and has no
code to pin — when one of them is built, its snippet moves up and gets a test here.
"""

from __future__ import annotations

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped providers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.tags import on_tag
from tests.utils.snippets import doc

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def tree(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    (src / "sub").mkdir(parents=True)
    (src / "alpha.md").write_text("# Alpha\n\nThe first note.\n")
    (src / "sub" / "beta.md").write_text("# Beta\n\nNested.\n")
    return src, dst


def _placed(dst):
    return sorted(p.relative_to(dst).as_posix() for p in dst.rglob("*.md"))


async def test_snippet_1_one_source_one_cycle(tree):
    src, _ = tree
    source = DataSource(name="Notes", provider="folder", config={"root": str(src)})
    await source.save()
    assert (await source.verify())["ready"] is True
    await source.sync()  # never raises; failure is health, not an exception


async def test_snippet_2_mirror_one_folder_into_another(tree):
    src, dst = tree
    source = DataSource(
        name="Mirror notes",
        provider="folder",
        reflect=ReflectMode.COPY.value,
        reflect_into=str(dst),
        config={"root": str(src)},
    )
    await source.save()
    await source.verify()

    await source.sync()
    assert _placed(dst) == ["alpha.md", "sub/beta.md"]

    (src / "alpha.md").write_text("# Alpha\n\nEdited.\n")
    (src / "gamma.md").write_text("# Gamma\n\nNew.\n")
    (src / "sub" / "beta.md").unlink()

    await source.sync()
    assert _placed(dst) == ["alpha.md", "gamma.md"]
    assert "Edited." in (dst / "alpha.md").read_text()
    # The mirror is not byte-identical: `folder` stamps identity into the copy.
    # The SOURCE is never written to, which is the half that matters.
    assert "id:" not in (src / "alpha.md").read_text()


async def test_snippet_3_react_to_a_change(tree):
    """`on_tag` returns its own unsubscribe, and the payload names what moved."""
    src, _ = tree
    seen: list[dict] = []
    off = on_tag("ingest.*.change.received", lambda event: seen.append(event.data))
    try:
        from flow_sdk.ingest.change_event import emit_change

        emit_change("src-1", "folder", refs=[str(src / "alpha.md")], tombstones=[])
    finally:
        off()

    assert seen and seen[0]["source_id"] == "src-1"
    assert seen[0]["refs"] == [str(src / "alpha.md")]
    # Identity and a locator, never content — that is what makes a replay harmless.
    assert "content" not in seen[0] and "bytes" not in seen[0]


# ── §2 (the block), §4, §5, §6 — the loops, run until their first ack ──────────


async def _acked_signal(monkeypatch):
    """An event that fires when a durable position commits a watermark — a loop's first ack."""
    import asyncio

    from flow_sdk.builtin.consumer_position import ConsumerPosition

    fired = asyncio.Event()
    original = ConsumerPosition.commit

    async def commit(self):
        await original(self)
        if self.watermark() is not None:
            fired.set()

    monkeypatch.setattr(ConsumerPosition, "commit", commit)
    return fired


def _pipes_doc(name: str) -> str:
    """The page with its workflow names made unique per test — positions are keyed on them."""
    from flow_sdk.api.api_types.identifier import mint_uuid

    text = doc("pipes.md")
    for wf in ("mirror", "triage", "docs-rag"):
        text = text.replace(f'workflow("{wf}")', f'workflow("{wf}-{mint_uuid()}")')
    return text


async def test_snippet_2_follow_a_folder(tmp_path, monkeypatch):
    from tests.utils.snippets import fence_under, run_fence_until

    src, dest = tmp_path / "src", tmp_path / "dest"
    src.mkdir()
    (src / "alpha.md").write_text("# Alpha\n\nThe first note.\n")
    acked = await _acked_signal(monkeypatch)
    ns = {"SRC": str(src), "DEST": str(dest)}
    await run_fence_until(fence_under(_pipes_doc("pipes.md"), "2.", nth=1), ns, acked, filename="pipes.md §2")
    assert (dest / "alpha.md").exists(), "the block mirrors like the source above"
    assert ns["change"].added and ns["change"].added[0].endswith("alpha.md")


async def test_snippet_4_cadence(tmp_path, monkeypatch):
    from tests.utils.snippets import fence_under, run_fence_until

    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("# a\n\nbody\n")
    acked = await _acked_signal(monkeypatch)
    await run_fence_until(fence_under(_pipes_doc("pipes.md"), "4."), {"SRC": str(src)}, acked, filename="pipes.md §4")


async def test_snippet_5_an_agent_on_several_sources(tmp_path, monkeypatch):
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.agent_registry import get_agent
    from tests.utils.fake_source import scripted_provider
    from tests.utils.mock_worker import MockDriver
    from tests.utils.snippets import fence_under, run_fence_until

    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)
    if await get_agent("triager") is None:
        await Agent(name="triager", worker_type="claude").save()
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("# a\n\nbody\n")

    with scripted_provider("agentmail") as mail:
        mail.push({"body": "please triage", "author": "alice@example.com", "thread_key": "t1"})
        await run_fence_until(
            fence_under(_pipes_doc("pipes.md"), "5."), {"KEY": "k", "SRC": str(src)}, mail.settled, filename="pipes.md §5"
        )
    assert worker.received_prompts == ["please triage"], "the folder page was acked, not answered"
    assert len(mail.sent) == 1


async def test_snippet_6_keep_a_search_index_level(tmp_path, monkeypatch):
    from flow_sdk.builtin.rag_index import RagIndex
    from flow_sdk.rag import reconcile
    from tests.unit.rag_embedder import embed_all
    from tests.utils.snippets import fence_under, run_fence_until

    async def embedder(index):
        async def _embed(texts):
            return embed_all(list(texts))
        return _embed, "ngram-test"

    async def some_endpoint(self):
        return object()

    monkeypatch.setattr(reconcile, "embedder_for", embedder)
    monkeypatch.setattr(RagIndex, "resolve_endpoint", some_endpoint)

    src = tmp_path / "src"
    src.mkdir()
    (src / "walk.md").write_text("# Walk\n\nThe walker skips ignored directories on the way down.\n")
    acked = await _acked_signal(monkeypatch)
    ns = {"SRC": str(src)}
    await run_fence_until(fence_under(_pipes_doc("pipes.md"), "6."), ns, acked, filename="pipes.md §6")
    assert ns["report"].embedded > 0
    hits = await ns["index"].search("which directories does the walker skip", top_k=1)
    assert hits and hits[0].doc_ref.endswith("walk.md")
