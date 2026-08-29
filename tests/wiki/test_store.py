"""AsyncLinkStore CRUD tests.

Uses the session-scoped `initialize_test_db` from `tests/conftest.py` which
opens an isolated sqlite file and registers the driver — the AsyncLinkStore
talks to it via `flow_sdk.db.session()`.
"""

import pytest
import pytest_asyncio
from sqlalchemy import delete as sa_delete

from flow_sdk.db import session
from flow_sdk.db.drivers.sqlite.connection import LinksSchema
from flow_sdk.wiki.store import AsyncLinkStore
from flow_sdk.wiki.types import WikiLink

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def store():
    """Fresh AsyncLinkStore bound to the shared session test DB.

    Each test wipes the links table at start and end via the shared engine.
    """
    async with session() as s:
        await s.execute(sa_delete(LinksSchema))
    yield AsyncLinkStore()
    async with session() as s:
        await s.execute(sa_delete(LinksSchema))


class TestReplaceForSource:
    async def test_insert_links(self, store):
        await store.replace_for_source(
            "skill",
            "skill-1",
            [
                WikiLink(raw="my-process", line=1,
                     target_type="agentic_process", target_id="proc-1"),
                WikiLink(raw="other", line=3,
                     target_type=None, target_id=None),
            ],
        )
        rows = await store.outgoing_from("skill", "skill-1")
        assert len(rows) == 2
        assert rows[0].raw == "my-process"
        assert rows[0].target_type == "agentic_process"
        assert rows[0].target_id == "proc-1"
        assert rows[0].line == 1
        assert rows[1].raw == "other"
        assert rows[1].target_type is None

    async def test_replace_overwrites_previous(self, store):
        await store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="first", line=1)],
        )
        await store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="second", line=1)],
        )
        rows = await store.outgoing_from("skill", "skill-1")
        assert len(rows) == 1
        assert rows[0].raw == "second"

    async def test_replace_with_empty_list_clears(self, store):
        await store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="something", line=1)],
        )
        await store.replace_for_source("skill", "skill-1", [])
        assert await store.outgoing_from("skill", "skill-1") == []

    async def test_other_sources_untouched(self, store):
        await store.replace_for_source("skill", "a", [WikiLink(raw="x", line=1)])
        await store.replace_for_source("skill", "b", [WikiLink(raw="y", line=1)])
        await store.replace_for_source("skill", "a", [WikiLink(raw="z", line=1)])
        assert [r.raw for r in await store.outgoing_from("skill", "a")] == ["z"]
        assert [r.raw for r in await store.outgoing_from("skill", "b")] == ["y"]


class TestBacklinks:
    async def test_backlinks_returns_only_matching_target(self, store):
        await store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="proc", line=1,
                  target_type="agentic_process", target_id="proc-1")],
        )
        await store.replace_for_source(
            "skill", "skill-2",
            [WikiLink(raw="proc", line=2,
                  target_type="agentic_process", target_id="proc-1")],
        )
        await store.replace_for_source(
            "skill", "skill-3",
            [WikiLink(raw="other", line=1,
                  target_type="agentic_process", target_id="proc-2")],
        )

        rows = await store.backlinks_of("agentic_process", "proc-1")
        assert len(rows) == 2
        assert {r.src_id for r in rows} == {"skill-1", "skill-2"}

    async def test_backlinks_ignores_unresolved(self, store):
        await store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="ghost", line=1,
                  target_type=None, target_id=None)],
        )
        assert await store.backlinks_of("agentic_process", "ghost") == []


class TestFindUnresolved:
    async def test_finds_only_unresolved_with_matching_raw(self, store):
        await store.replace_for_source(
            "skill", "skill-1",
            [
                WikiLink(raw="ghost", line=1, target_type=None, target_id=None),
                WikiLink(raw="ghost", line=2,
                     target_type="agentic_process", target_id="proc-1"),
                WikiLink(raw="other-ghost", line=3,
                     target_type=None, target_id=None),
            ],
        )
        rows = await store.find_unresolved("ghost")
        assert len(rows) == 1
        assert rows[0].line == 1
