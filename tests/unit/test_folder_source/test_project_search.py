"""The user-facing assertion: is it findable in the PROJECT?

Everything else in this package asserts the machinery. This module asserts the
outcome the feature exists for — write a file into a watched folder, and find it
by its content in the project it belongs to.

It exercises the real predicate rather than the stamp. Project scoping for
search is NOT in SQL: `Entity.search` goes straight to FTS with no scope
parameter, and `routes/search.py` post-filters the hydrated hits in Python with
`apply_scope_filter`. Asserting on `project_id` alone would therefore pass while
the actual search surface returned nothing — the two fields are read together,
and an empty `scope` is DROPPED for a scoped type like markdown.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.server.search_filters import (
    SCOPED_RECORD_TYPES,
    ScopeFilter,
    apply_scope_filter,
    resolve_project_scope,
)

from ._harness import poll, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MODES = [ReflectMode.NONE.value, ReflectMode.COPY.value, ReflectMode.SYMLINK.value]

#: A bare alphanumeric token, deliberately. FTS appends `*` per term and quotes
#: anything containing `.+^(){}[]~?\/:!-`, and the search route pre-strips
#: `-/_:` — a needle with punctuation would be testing the tokenizer.
NEEDLE = "quartzfeather"


async def _scoped_hits(project_id: str) -> list:
    hits = await Entity.search(NEEDLE, limit=50, record_type="markdown")
    sf = await resolve_project_scope(ScopeFilter(user=False, projects=(project_id,)))
    return apply_scope_filter(hits, sf)


async def test_markdown_is_actually_scope_filtered():
    """Guard the guard.

    If `markdown` ever leaves `SCOPED_RECORD_TYPES`, an empty-scope row passes
    the filter unconditionally and every assertion below starts passing for the
    wrong reason. `spreadsheet` and `dataset` are already in that position,
    which is why the fixtures here are markdown.
    """
    assert "markdown" in SCOPED_RECORD_TYPES


@pytest.mark.parametrize("mode", MODES)
async def test_written_file_is_findable_in_its_project(
    folder_db, watched, project, make_source, mode
):
    write_doc(watched)
    source, proj = await make_source(mode)

    await poll(source)

    found = await _scoped_hits(str(proj.id))
    assert found, f"{mode}: indexed but not findable in the project"


@pytest.mark.parametrize("mode", MODES)
async def test_another_project_does_not_see_it(
    folder_db, watched, project, make_source, mode
):
    """Scoping must EXCLUDE, not merely include.

    A filter that returned everything would satisfy the test above, so the
    negative case is what proves the project boundary is real.
    """
    from flow_sdk.builtin.project import Project

    write_doc(watched)
    source, _proj = await make_source(mode)
    other = Project(name="unrelated", fs_storage_mount_path=str(project / "elsewhere"))
    await other.save()

    await poll(source)

    assert not await _scoped_hits(str(other.id)), f"{mode}: leaked into an unrelated project"


@pytest.mark.parametrize("mode", MODES)
async def test_deleted_file_leaves_the_project_index(
    folder_db, watched, project, make_source, mode
):
    """Deletion has to reach search, not just the row.

    A stale FTS entry for a deleted file is the failure users actually report —
    the answer cites a document that no longer exists.
    """
    path = write_doc(watched)
    source, proj = await make_source(mode)
    await poll(source)
    assert await _scoped_hits(str(proj.id)), "precondition: should be findable first"

    path.unlink()
    await poll(source)

    assert not await _scoped_hits(str(proj.id)), f"{mode}: deleted file still searchable"
