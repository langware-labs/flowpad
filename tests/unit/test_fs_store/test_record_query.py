"""Tests for RecordQuery — filtering, sorting, pagination, composition."""

from datetime import datetime, timezone
from typing import ClassVar

import pytest

from flow_sdk.fs_store import Record
from flow_sdk.fs_store.record_query import RecordQuery
from flow_sdk.fs_store.record_ref import RecordRef


class QRecord(Record):
    _record_type: ClassVar[str] = "qtest"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "qtest")
        super().__init__(**kwargs)


def _rec(uid: str, **kwargs) -> QRecord:
    return QRecord(id=uid, **kwargs)


class TestBasicFilters:
    def test_filter_by_ids(self):
        recs = [_rec("a"), _rec("b"), _rec("c")]
        q = RecordQuery(ids=["a", "c"])
        assert [r.id for r in q.apply(recs)] == ["a", "c"]

    def test_filter_by_types(self):
        r1 = _rec("1")
        r2 = Record(id="2", type="other")
        q = RecordQuery(types=["qtest"])
        assert q.apply([r1, r2]) == [r1]

    def test_filter_by_status(self):
        r1 = _rec("1", status="active")
        r2 = _rec("2", status="orphan")
        q = RecordQuery(status="active")
        assert q.apply([r1, r2]) == [r1]

    def test_filter_by_status_list(self):
        r1 = _rec("1", status="active")
        r2 = _rec("2", status="orphan")
        r3 = _rec("3", status="new")
        q = RecordQuery(status=["active", "new"])
        assert len(q.apply([r1, r2, r3])) == 2


class TestDateFilters:
    def test_created_after(self):
        t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t2 = datetime(2026, 6, 1, tzinfo=timezone.utc)
        r1 = _rec("1", created_at=t1)
        r2 = _rec("2", created_at=t2)
        q = RecordQuery(created_after=datetime(2026, 3, 1, tzinfo=timezone.utc))
        assert q.apply([r1, r2]) == [r2]

    def test_created_before(self):
        t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t2 = datetime(2026, 6, 1, tzinfo=timezone.utc)
        r1 = _rec("1", created_at=t1)
        r2 = _rec("2", created_at=t2)
        q = RecordQuery(created_before=datetime(2026, 3, 1, tzinfo=timezone.utc))
        assert q.apply([r1, r2]) == [r1]

    def test_modified_after(self):
        t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t2 = datetime(2026, 6, 1, tzinfo=timezone.utc)
        r1 = _rec("1", modified_at=t1)
        r2 = _rec("2", modified_at=t2)
        q = RecordQuery(modified_after=datetime(2026, 3, 1, tzinfo=timezone.utc))
        assert q.apply([r1, r2]) == [r2]

    def test_none_dates_excluded(self):
        r1 = _rec("1")  # no created_at
        q = RecordQuery(created_after=datetime(2026, 1, 1, tzinfo=timezone.utc))
        assert q.apply([r1]) == []


class TestParentFilter:
    def test_parent_id(self):
        r1 = _rec("1", parent_ref=RecordRef(id="parent-1"))
        r2 = _rec("2", parent_ref=RecordRef(id="parent-2"))
        r3 = _rec("3")
        q = RecordQuery(parent_id="parent-1")
        assert q.apply([r1, r2, r3]) == [r1]


class TestPredicate:
    def test_custom_predicate(self):
        r1 = _rec("1", name="alpha")
        r2 = _rec("2", name="beta")
        q = RecordQuery(predicate=lambda r: r.name.startswith("a"))
        assert q.apply([r1, r2]) == [r1]


class TestSortAndPagination:
    def test_sort_by_name_desc(self):
        r1 = _rec("1", name="alpha")
        r2 = _rec("2", name="charlie")
        r3 = _rec("3", name="beta")
        q = RecordQuery(sort_by="name", sort_desc=True)
        result = q.apply([r1, r2, r3])
        assert [r.name for r in result] == ["charlie", "beta", "alpha"]

    def test_sort_by_name_asc(self):
        r1 = _rec("1", name="charlie")
        r2 = _rec("2", name="alpha")
        q = RecordQuery(sort_by="name", sort_desc=False)
        result = q.apply([r1, r2])
        assert [r.name for r in result] == ["alpha", "charlie"]

    def test_limit(self):
        recs = [_rec(str(i)) for i in range(10)]
        q = RecordQuery(limit=3)
        assert len(q.apply(recs)) == 3

    def test_offset(self):
        recs = [_rec(str(i), name=f"n{i}") for i in range(5)]
        q = RecordQuery(offset=2)
        assert len(q.apply(recs)) == 3

    def test_offset_and_limit(self):
        recs = [_rec(str(i), name=f"n{i}") for i in range(10)]
        q = RecordQuery(offset=3, limit=2)
        result = q.apply(recs)
        assert len(result) == 2
        assert result[0].id == "3"
        assert result[1].id == "4"


class TestComposition:
    def test_combine_filters(self):
        t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t2 = datetime(2026, 6, 1, tzinfo=timezone.utc)
        r1 = _rec("1", name="alpha", created_at=t1, status="active")
        r2 = _rec("2", name="beta", created_at=t2, status="active")
        r3 = _rec("3", name="gamma", created_at=t2, status="orphan")
        q = RecordQuery(
            status="active",
            created_after=datetime(2026, 3, 1, tzinfo=timezone.utc),
        )
        assert q.apply([r1, r2, r3]) == [r2]

    def test_empty_query_passes_all(self):
        recs = [_rec("1"), _rec("2"), _rec("3")]
        q = RecordQuery()
        assert len(q.apply(recs)) == 3
