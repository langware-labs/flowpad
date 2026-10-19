"""``RagIndex`` roots: which folders an index covers, and how it says why it cannot run.

Roots are context links to ``Folder`` entities, not a stored list of strings — the same shape
``Project.include_dirs`` uses, and deliberately so: a stored ``include_dirs: list[str]`` is the
field the codebase removed from ``Project``, because a second list of paths is a second answer
to "which folders are covered".
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.rag_index import RagIndex, RagStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: A real uuid4 — ``project_id`` is parsed as a TypeId, so a placeholder like "p1" raises.
PROJECT = "11111111-2222-4333-8444-555555555555"


@pytest.fixture(autouse=True)
async def _empty_box():
    """Start every test with no indexes on the box.

    ``ensure_default`` answers a question about the WHOLE instance, so a row a previous test
    left behind is the row it finds. The suite shares one database; without this the toggle
    tests pass or fail depending on which siblings ran first.
    """
    for status in RagStatus:
        for index in await RagIndex.get_all({"status": status.value}):
            await index.destroy()
    yield


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    (tmp_path / "docs" / "auth").mkdir(parents=True)
    (tmp_path / "notes").mkdir()
    (tmp_path / "docs" / "intro.md").write_text("# Intro\n\nHello.\n")
    (tmp_path / "docs" / "auth" / "tokens.md").write_text("# Tokens\n\nRotate.\n")
    return tmp_path


# ── adding and removing ──────────────────────────────────────────────────────


async def test_a_new_index_covers_nothing(tree):
    assert RagIndex(name="Default RAG").roots == []


async def test_adding_a_root_makes_it_covered(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    assert index.roots == [str(tree / "docs")]


async def test_adding_the_same_root_twice_links_it_once(tree):
    """Idempotent: the folder entity is get-or-create and the link dedups."""
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    await index.add_root(str(tree / "docs"))
    assert index.roots == [str(tree / "docs")]


async def test_two_roots_are_both_kept(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    await index.add_root(str(tree / "notes"))
    assert set(index.roots) == {str(tree / "docs"), str(tree / "notes")}


async def test_adding_a_root_marks_the_index_pending(tree):
    """New coverage is work to do; the background pass decides how much."""
    index = RagIndex(name="Default RAG")
    assert index.pending is False
    await index.add_root(str(tree / "docs"))
    assert index.pending is True


async def test_removing_a_root_uncovers_it(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    await index.add_root(str(tree / "notes"))
    await index.remove_root(str(tree / "docs"))
    assert index.roots == [str(tree / "notes")]


async def test_removing_a_root_that_was_never_added_is_a_no_op(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    await index.remove_root(str(tree / "nope"))
    assert index.roots == [str(tree / "docs")]


async def test_a_blank_path_is_refused_by_both_verbs(tree):
    index = RagIndex(name="Default RAG")
    assert (await index.add_root("")).status != "SUCCESS"
    assert (await index.remove_root("")).status != "SUCCESS"


# ── coverage ─────────────────────────────────────────────────────────────────


async def test_a_file_under_a_root_is_covered(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    assert index.covers(str(tree / "docs" / "intro.md")) == str(tree / "docs")
    assert index.covers(str(tree / "docs" / "auth" / "tokens.md")) == str(tree / "docs")


def test_a_file_outside_every_root_is_not_covered(tree):
    index = RagIndex(name="Default RAG")
    assert index.covers(str(tree / "notes" / "x.md")) == ""


async def test_a_root_covers_itself(tree):
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    assert index.covers(str(tree / "docs")) == str(tree / "docs")


async def test_the_deepest_root_wins_when_they_nest(tree):
    """So a document is attributed to one place, and a nested root's settings apply."""
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    await index.add_root(str(tree / "docs" / "auth"))
    assert index.covers(str(tree / "docs" / "auth" / "tokens.md")) == str(tree / "docs" / "auth")


async def test_a_sibling_with_a_shared_prefix_is_not_covered(tree):
    """``/docs`` must not swallow ``/docs-archive``, which a string prefix test would."""
    (tree / "docs-archive").mkdir()
    index = RagIndex(name="Default RAG")
    await index.add_root(str(tree / "docs"))
    assert index.covers(str(tree / "docs-archive" / "old.md")) == ""


# ── refusals ─────────────────────────────────────────────────────────────────


def test_a_fresh_index_says_it_has_no_endpoint():
    assert RagIndex().index_refusal() == "no embedding endpoint is bound yet"


def test_a_disabled_index_says_so():
    assert RagIndex(status=RagStatus.DISABLED).index_refusal() == "this index is disabled"


def test_an_active_index_with_no_roots_says_that():
    assert RagIndex(status=RagStatus.ACTIVE).index_refusal() == "this index covers no folders yet"


async def test_an_active_index_with_a_root_refuses_nothing(tree):
    index = RagIndex(status=RagStatus.ACTIVE)
    await index.add_root(str(tree / "docs"))
    assert index.index_refusal() == ""


def test_a_setup_index_reports_its_own_error_when_it_has_one():
    """One author for the sentence: verify writes it, the refusal renders it."""
    index = RagIndex(status=RagStatus.SETUP, last_error="the openrouter key was rejected")
    assert index.index_refusal() == "the openrouter key was rejected"


# ── resolving an index from a path ───────────────────────────────────────────


async def test_covering_finds_the_index_that_owns_a_path(tree):
    """What the post-index observer asks, once per changed document."""
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT)
    await index.add_root(str(tree / "docs"))
    found = await RagIndex.covering(str(tree / "docs" / "intro.md"), project_id=PROJECT)
    assert found is not None and found.id == index.id


async def test_covering_answers_none_for_an_uncovered_path(tree):
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT)
    await index.add_root(str(tree / "docs"))
    assert await RagIndex.covering(str(tree / "notes" / "x.md"), project_id=PROJECT) is None


async def test_covering_ignores_a_disabled_index(tree):
    """A person turned it off; a file change must not quietly resurrect the work."""
    index = RagIndex(status=RagStatus.DISABLED, project_id=PROJECT)
    await index.add_root(str(tree / "docs"))
    assert await RagIndex.covering(str(tree / "docs" / "intro.md"), project_id=PROJECT) is None


async def test_covering_prefers_the_deepest_root_across_indexes(tree):
    broad = RagIndex(name="broad", status=RagStatus.ACTIVE, project_id=PROJECT)
    await broad.add_root(str(tree / "docs"))
    narrow = RagIndex(name="narrow", status=RagStatus.ACTIVE, project_id=PROJECT)
    await narrow.add_root(str(tree / "docs" / "auth"))
    found = await RagIndex.covering(str(tree / "docs" / "auth" / "tokens.md"), project_id=PROJECT)
    assert found is not None and found.name == "narrow"


# ── the store ────────────────────────────────────────────────────────────────


def test_the_store_lives_in_the_instance_not_in_a_project(tree):
    """Derived, machine-local and rebuildable, so it must never travel with a share."""
    index = RagIndex()
    assert "rag_index" in str(index.store_dir)
    assert not str(index.store_dir).startswith(str(tree))


async def test_destroy_takes_the_vectors_with_it(tree):
    """Nothing sweeps the records-data root, so an index deleted without this leaks."""
    index = RagIndex(status=RagStatus.ACTIVE)
    await index.save()
    async with index.open_store() as store:
        store.stamp(tree_hash="h1", root=str(tree / "docs"))
    assert index.store_dir.exists()

    await index.destroy()
    assert not index.store_dir.exists()


async def test_removing_a_root_updates_the_counts_in_the_same_write(tmp_path):
    """The write has to carry a changed FIELD, not only a sidecar unlink.

    Unlinking the folder alone leaves every field identical, and a save with nothing changed
    broadcasts nothing — so an open tree kept showing the brain on a folder that was no longer
    covered until someone reloaded the page.
    """
    root = tmp_path / "docs"
    root.mkdir()
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT, chunk_count=7, document_count=2)
    await index.add_root(str(root))
    await index.save(notify=False)

    await index.remove_root(str(root))
    assert index.roots == []
    assert (index.chunk_count, index.document_count) == (0, 0)


async def test_two_holders_of_one_store_are_serialized(tmp_path):
    """The store is a native index over files; two live handles crash the process.

    Not hypothetical. Dropping a root while a pass was embedding took the backend down with no
    traceback at all — usearch is C++, and it does not raise on the way out. So access is
    serialized per index, and a second holder waits rather than opening its own handle.
    """
    import asyncio

    root = tmp_path / "docs"
    root.mkdir()
    index = RagIndex(status=RagStatus.ACTIVE, project_id=PROJECT)
    await index.add_root(str(root))
    await index.save(notify=False)

    order: list[str] = []

    async def holder():
        async with index.open_store():
            order.append("first-in")
            await asyncio.sleep(0.05)
            order.append("first-out")

    async def latecomer():
        await asyncio.sleep(0.01)  # after the first is inside
        async with index.open_store():
            order.append("second-in")

    await asyncio.gather(holder(), latecomer())
    assert order == ["first-in", "first-out", "second-in"]


# ── the toggle the tree offers ───────────────────────────────────────────────


async def test_the_first_toggle_creates_the_box_index(tmp_path):
    """A folder row asks "make this searchable" and that is the whole interaction.

    Requiring a visit to the Search indexes screen first would make the common case — one index,
    a few folders — a two-screen errand.
    """
    root = tmp_path / "docs"
    root.mkdir()
    index, covered = await RagIndex.toggle_root(str(root))

    assert covered is True
    assert index.roots == [str(root)]
    assert len(await RagIndex.get_all({"name": index.name})) == 1


async def test_toggling_again_uncovers_it(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    await RagIndex.toggle_root(str(root))
    index, covered = await RagIndex.toggle_root(str(root))

    assert covered is False
    assert index.roots == []


async def test_a_second_folder_joins_the_same_index(tmp_path):
    """One index until there is a reason for two; the toggle never mints a second."""
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    first, _ = await RagIndex.toggle_root(str(a))
    second, _ = await RagIndex.toggle_root(str(b))

    assert first.id == second.id
    assert sorted(second.roots) == sorted([str(a), str(b)])


async def test_ensure_default_answers_the_oldest_row(tmp_path):
    """Two rows minted by a race must not make the toggle flip between them."""
    older = RagIndex(status=RagStatus.ACTIVE, name="older")
    await older.save(notify=False)
    newer = RagIndex(status=RagStatus.ACTIVE, name="newer")
    await newer.save(notify=False)

    assert (await RagIndex.ensure_default()).id == older.id
    assert (await RagIndex.ensure_default()).id == older.id


async def test_ensure_default_reuses_a_setup_index_rather_than_adding_one(tmp_path):
    """SETUP just means nothing funds it yet — it is still the box's index."""
    existing = RagIndex(status=RagStatus.SETUP, name="waiting")
    await existing.save(notify=False)

    assert (await RagIndex.ensure_default()).id == existing.id
