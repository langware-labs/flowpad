"""LinkStore CRUD tests.

Uses the session-scoped `initialize_test_db` from `tests/conftest.py` which
opens an isolated sqlite file and registers the driver — the wiki LinkStore
inherits that path automatically via `get_db_driver().config.database`.
"""

import pytest

from flow_sdk.wiki.store import LinkStore, reset_default_store
from flow_sdk.wiki.types import WikiLink


@pytest.fixture
def store():
    """Fresh LinkStore bound to the shared session test DB.

    Each test wipes any rows it inserts at the end via reset_default_store
    plus a per-test DELETE in setup. Cheap; lets us parallelize within
    a session without cross-test bleed.
    """
    reset_default_store()
    s = LinkStore()
    # Clean slate per test
    s._connection().execute("DELETE FROM links")
    yield s
    # Same — clean up after
    s._connection().execute("DELETE FROM links")
    s.close()


class TestReplaceForSource:
    def test_insert_links(self, store):
        store.replace_for_source(
            "skill",
            "skill-1",
            [
                WikiLink(raw="my-process", line=1,
                     target_type="agentic_process", target_id="proc-1"),
                WikiLink(raw="other", line=3,
                     target_type=None, target_id=None),
            ],
        )
        rows = store.outgoing_from("skill", "skill-1")
        assert len(rows) == 2
        assert rows[0].raw == "my-process"
        assert rows[0].target_type == "agentic_process"
        assert rows[0].target_id == "proc-1"
        assert rows[0].line == 1
        assert rows[1].raw == "other"
        assert rows[1].target_type is None

    def test_replace_overwrites_previous(self, store):
        store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="first", line=1)],
        )
        store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="second", line=1)],
        )
        rows = store.outgoing_from("skill", "skill-1")
        assert len(rows) == 1
        assert rows[0].raw == "second"

    def test_replace_with_empty_list_clears(self, store):
        store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="something", line=1)],
        )
        store.replace_for_source("skill", "skill-1", [])
        assert store.outgoing_from("skill", "skill-1") == []

    def test_other_sources_untouched(self, store):
        store.replace_for_source("skill", "a", [WikiLink(raw="x", line=1)])
        store.replace_for_source("skill", "b", [WikiLink(raw="y", line=1)])
        store.replace_for_source("skill", "a", [WikiLink(raw="z", line=1)])
        assert [r.raw for r in store.outgoing_from("skill", "a")] == ["z"]
        assert [r.raw for r in store.outgoing_from("skill", "b")] == ["y"]


class TestBacklinks:
    def test_backlinks_returns_only_matching_target(self, store):
        store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="proc", line=1,
                  target_type="agentic_process", target_id="proc-1")],
        )
        store.replace_for_source(
            "skill", "skill-2",
            [WikiLink(raw="proc", line=2,
                  target_type="agentic_process", target_id="proc-1")],
        )
        store.replace_for_source(
            "skill", "skill-3",
            [WikiLink(raw="other", line=1,
                  target_type="agentic_process", target_id="proc-2")],
        )

        rows = store.backlinks_of("agentic_process", "proc-1")
        assert len(rows) == 2
        assert {r.src_id for r in rows} == {"skill-1", "skill-2"}

    def test_backlinks_ignores_unresolved(self, store):
        store.replace_for_source(
            "skill", "skill-1",
            [WikiLink(raw="ghost", line=1,
                  target_type=None, target_id=None)],
        )
        assert store.backlinks_of("agentic_process", "ghost") == []


class TestFindUnresolved:
    def test_finds_only_unresolved_with_matching_raw(self, store):
        store.replace_for_source(
            "skill", "skill-1",
            [
                WikiLink(raw="ghost", line=1, target_type=None, target_id=None),
                WikiLink(raw="ghost", line=2,
                     target_type="agentic_process", target_id="proc-1"),
                WikiLink(raw="other-ghost", line=3,
                     target_type=None, target_id=None),
            ],
        )
        rows = store.find_unresolved("ghost")
        assert len(rows) == 1
        assert rows[0].line == 1


class TestPathResolution:
    def test_path_comes_from_registered_driver(self, store):
        from flow_sdk.db.drivers.db_driver import get_db_driver
        driver = get_db_driver()
        assert store._path == driver.config.database
