"""Tests for unified RecordList — CRUD via discover/persist."""

from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.fs_store import Record, RecordList, RecordQuery
from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root


class OwnedRecord(Record):
    """Owned record type for tests (directory-scan based)."""
    _record_type: ClassVar[str] = "rl_test"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "rl_test")
        super().__init__(**kwargs)


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_path):
    """Redirect records root to tmp_path for all tests."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield
    set_default_records_root(original)


class TestCrud:
    def test_create_and_get(self):
        rl = RecordList(record_class=OwnedRecord)
        rec = rl.create(OwnedRecord(id="1", name="alpha"))
        assert rec.id == "1"
        fetched = rl.get("1")
        assert fetched is not None
        assert fetched.name == "alpha"

    def test_create_from_dict(self):
        rl = RecordList(record_class=OwnedRecord)
        rec = rl.create({"id": "d1", "type": "rl_test", "name": "from-dict"})
        assert rec.id == "d1"
        assert rl.get("d1").name == "from-dict"

    def test_create_duplicate_raises(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="dup", name="first"))
        with pytest.raises(ValueError, match="already exists"):
            rl.create(OwnedRecord(id="dup", name="second"))

    def test_get_missing_returns_none(self):
        rl = RecordList(record_class=OwnedRecord)
        assert rl.get("nope") is None

    def test_update(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="u1", name="before"))
        updated = rl.update("u1", {"name": "after"})
        assert updated.name == "after"
        assert rl.get("u1").name == "after"

    def test_update_missing_raises(self):
        rl = RecordList(record_class=OwnedRecord)
        with pytest.raises(KeyError, match="No record"):
            rl.update("nope", {"name": "x"})

    @pytest.mark.asyncio
    async def test_delete(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="d1"))
        assert await rl.delete("d1") is True
        assert rl.get("d1") is None

    @pytest.mark.asyncio
    async def test_delete_missing_returns_false(self):
        rl = RecordList(record_class=OwnedRecord)
        assert await rl.delete("ghost") is False


class TestIteration:
    def test_iter_and_len(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="a"))
        rl.create(OwnedRecord(id="b"))
        ids = [r.id for r in rl]
        assert "a" in ids
        assert "b" in ids
        assert len(rl) == 2

    def test_records_property(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="r1"))
        recs = rl.records
        assert len(recs) == 1
        assert recs[0].id == "r1"


class TestQuery:
    def test_query_by_ids(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="a", name="alpha"))
        rl.create(OwnedRecord(id="b", name="beta"))
        rl.create(OwnedRecord(id="c", name="gamma"))
        q = RecordQuery(ids=["a", "c"])
        result = rl.query(q)
        assert len(result) == 2
        assert {r.id for r in result} == {"a", "c"}

    def test_query_with_limit(self):
        rl = RecordList(record_class=OwnedRecord)
        for i in range(5):
            rl.create(OwnedRecord(id=str(i)))
        q = RecordQuery(limit=2)
        assert len(rl.query(q)) == 2


class TestPersistence:
    def test_create_persists_to_disk(self):
        rl = RecordList(record_class=OwnedRecord)
        rl.create(OwnedRecord(id="s1", name="first"))

        rl2 = RecordList(record_class=OwnedRecord)
        assert rl2.get("s1").name == "first"
