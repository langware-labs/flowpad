"""Tests for resolve_link.

Inserts entity rows directly with sqlite3 against the test DB to exercise
the resolver's matching/precedence logic. (Insertion is test-fixture
plumbing — production paths are tested in the north-star integration test.)
"""

import pytest

from flow_sdk.wiki.resolver import resolve_link, _record_name_from_raw
from flow_sdk.wiki.store import LinkStore, reset_default_store
from flow_sdk.wiki.types import WikiLink


@pytest.fixture
def store():
    reset_default_store()
    s = LinkStore()
    c = s._connection()
    c.execute("DELETE FROM links")
    c.execute("DELETE FROM entities")
    yield s
    c.execute("DELETE FROM links")
    c.execute("DELETE FROM entities")
    s.close()


def _insert_entity(store: LinkStore, *, type: str, id: str, uname: str) -> None:
    store._connection().execute(
        "INSERT INTO entities (id, type, uname) VALUES (?, ?, ?)",
        (id, type, uname),
    )


class TestRecordNameFromRaw:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("my-process", "my-process"),
            ("my-process|alias", "my-process"),
            ("my-process#install", "my-process"),
            ("my-process^block-1", "my-process"),
            ("my-process#install|Setup", "my-process"),
            ("my-skill/resources/x.txt", "my-skill"),
            ("./my-process.md", "my-process"),
            ("./my-process.md#install", "my-process"),
            ("my-process.md", "my-process"),
        ],
    )
    def test_extracts_record_name(self, raw, expected):
        assert _record_name_from_raw(raw) == expected


class TestResolution:
    def test_unique_name_resolves(self, store):
        _insert_entity(store, type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process", line=1)

        resolved = resolve_link(link, src_type="skill", src_id="skill-1")

        assert resolved.target_type == "agentic_process"
        assert resolved.target_id == "proc-1"
        assert resolved.src_type == "skill"
        assert resolved.src_id == "skill-1"
        # raw and line preserved
        assert resolved.raw == "my-process"
        assert resolved.line == 1

    def test_unknown_name_stays_unresolved(self, store):
        link = WikiLink(raw="ghost", line=1)
        resolved = resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_type is None
        assert resolved.target_id is None
        # src is still filled
        assert resolved.src_type == "skill"
        assert resolved.src_id == "skill-1"

    def test_alias_link_resolves_by_record_name(self, store):
        _insert_entity(store, type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process|the process", line=1)
        resolved = resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"

    def test_heading_link_resolves_by_record_name(self, store):
        _insert_entity(store, type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process#install", line=1)
        resolved = resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"

    def test_subpath_link_resolves_by_first_segment(self, store):
        _insert_entity(store, type="skill", id="skill-1", uname="my-skill")
        link = WikiLink(raw="my-skill/resources/setup.txt", line=1)
        resolved = resolve_link(link, src_type="doc", src_id="doc-1")
        assert resolved.target_type == "skill"
        assert resolved.target_id == "skill-1"

    def test_md_link_resolves(self, store):
        _insert_entity(store, type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="./my-process.md", line=1)
        resolved = resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"


class TestPrecedence:
    def test_same_type_wins(self, store):
        _insert_entity(store, type="skill", id="s-1", uname="setup")
        _insert_entity(store, type="doc", id="d-1", uname="setup")
        _insert_entity(store, type="agent", id="a-1", uname="setup")

        link = WikiLink(raw="setup", line=1)
        resolved = resolve_link(link, src_type="doc", src_id="src")
        assert resolved.target_type == "doc"
        assert resolved.target_id == "d-1"

    def test_falls_back_to_alphabetical(self, store):
        _insert_entity(store, type="skill", id="s-1", uname="setup")
        _insert_entity(store, type="doc", id="d-1", uname="setup")

        # source type "agent" is not in the candidates → alphabetical
        link = WikiLink(raw="setup", line=1)
        resolved = resolve_link(link, src_type="agent", src_id="src")
        # "doc" < "skill"
        assert resolved.target_type == "doc"
