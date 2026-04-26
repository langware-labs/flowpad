"""Tests for resolve_link.

Inserts entity rows directly through the SQLAlchemy session to exercise
the resolver's matching/precedence logic.
"""

import pytest
import pytest_asyncio
from sqlalchemy import delete as sa_delete, insert as sa_insert

from flow_sdk.db import session
from flow_sdk.db.drivers.sqlite.connection import EntitySchema, LinksSchema
from flow_sdk.wiki.resolver import _record_name_from_raw, resolve_link
from flow_sdk.wiki.types import WikiLink


pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def store():
    async with session() as s:
        await s.execute(sa_delete(LinksSchema))
        await s.execute(sa_delete(EntitySchema))
    yield None
    async with session() as s:
        await s.execute(sa_delete(LinksSchema))
        await s.execute(sa_delete(EntitySchema))


async def _insert_entity(*, type: str, id: str, uname: str) -> None:
    async with session() as s:
        await s.execute(
            sa_insert(EntitySchema).values(id=id, type=type, uname=uname)
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
    async def test_unique_name_resolves(self, store):
        await _insert_entity(type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process", line=1)

        resolved = await resolve_link(link, src_type="skill", src_id="skill-1")

        assert resolved.target_type == "agentic_process"
        assert resolved.target_id == "proc-1"
        assert resolved.src_type == "skill"
        assert resolved.src_id == "skill-1"
        # raw and line preserved
        assert resolved.raw == "my-process"
        assert resolved.line == 1

    async def test_unknown_name_stays_unresolved(self, store):
        link = WikiLink(raw="ghost", line=1)
        resolved = await resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_type is None
        assert resolved.target_id is None
        # src is still filled
        assert resolved.src_type == "skill"
        assert resolved.src_id == "skill-1"

    async def test_alias_link_resolves_by_record_name(self, store):
        await _insert_entity(type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process|the process", line=1)
        resolved = await resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"

    async def test_heading_link_resolves_by_record_name(self, store):
        await _insert_entity(type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="my-process#install", line=1)
        resolved = await resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"

    async def test_subpath_link_resolves_by_first_segment(self, store):
        await _insert_entity(type="skill", id="skill-1", uname="my-skill")
        link = WikiLink(raw="my-skill/resources/setup.txt", line=1)
        resolved = await resolve_link(link, src_type="doc", src_id="doc-1")
        assert resolved.target_type == "skill"
        assert resolved.target_id == "skill-1"

    async def test_md_link_resolves(self, store):
        await _insert_entity(type="agentic_process", id="proc-1", uname="my-process")
        link = WikiLink(raw="./my-process.md", line=1)
        resolved = await resolve_link(link, src_type="skill", src_id="skill-1")
        assert resolved.target_id == "proc-1"


class TestPrecedence:
    async def test_same_type_wins(self, store):
        await _insert_entity(type="skill", id="s-1", uname="setup")
        await _insert_entity(type="doc", id="d-1", uname="setup")
        await _insert_entity(type="agent", id="a-1", uname="setup")

        link = WikiLink(raw="setup", line=1)
        resolved = await resolve_link(link, src_type="doc", src_id="src")
        assert resolved.target_type == "doc"
        assert resolved.target_id == "d-1"

    async def test_falls_back_to_alphabetical(self, store):
        await _insert_entity(type="skill", id="s-1", uname="setup")
        await _insert_entity(type="doc", id="d-1", uname="setup")

        # source type "agent" is not in the candidates → alphabetical
        link = WikiLink(raw="setup", line=1)
        resolved = await resolve_link(link, src_type="agent", src_id="src")
        # "doc" < "skill"
        assert resolved.target_type == "doc"
