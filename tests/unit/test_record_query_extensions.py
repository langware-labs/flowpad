"""Tests for RecordQuery extensions — field_predicates, scope, to_provider_params."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

from flow_sdk.fs_store.record_query import RecordQuery
from flow_sdk.fs_store.scope import Scope


def _make_record(uid="r1", scope=None, data=None, status=None):
    rec = MagicMock()
    rec.id = uid
    rec.type = "test"
    rec.scope = scope
    rec.status = status
    rec.created_at = None
    rec.modified_at = None
    rec.parent_ref = None
    # Set any data fields directly as attributes on the mock
    if data:
        for k, v in data.items():
            setattr(rec, k, v)
    else:
        # Ensure getattr returns None for unknown field predicates
        rec.priority = None
    return rec


class TestFieldPredicates:
    def test_field_predicates_match(self):
        rec = _make_record(data={"priority": "high"})
        q = RecordQuery(field_predicates={"priority": "high"})
        assert q.matches(rec)

    def test_field_predicates_no_match(self):
        rec = _make_record(data={"priority": "low"})
        q = RecordQuery(field_predicates={"priority": "high"})
        assert not q.matches(rec)

    def test_field_predicates_data_none(self):
        rec = _make_record(data=None)
        q = RecordQuery(field_predicates={"priority": "high"})
        assert not q.matches(rec)


class TestScopeFilter:
    def test_scope_filter_enum(self):
        rec = _make_record(scope=Scope.PROJECT)
        q = RecordQuery(scope=Scope.PROJECT)
        assert q.matches(rec)

    def test_scope_filter_string_coercion(self):
        rec = _make_record(scope="project")
        q = RecordQuery(scope=Scope.PROJECT)
        assert q.matches(rec)

    def test_scope_filter_no_match(self):
        rec = _make_record(scope=Scope.USER)
        q = RecordQuery(scope=Scope.PROJECT)
        assert not q.matches(rec)


class TestToProviderParams:
    def test_to_provider_params_complete(self):
        q = RecordQuery(
            types=["note"],
            status="active",
            ids=["id1"],
            parent_id="p1",
            scope=Scope.PROJECT,
            limit=10,
            offset=5,
            sort_by="name",
            sort_desc=False,
            modified_after=datetime(2026, 1, 1),
            modified_before=datetime(2026, 12, 31),
            created_after=datetime(2026, 1, 1),
            created_before=datetime(2026, 6, 1),
            field_predicates={"priority": "high"},
        )
        params = q.to_provider_params()
        assert params["types"] == ["note"]
        assert params["status"] == "active"
        assert params["ids"] == ["id1"]
        assert params["parent_id"] == "p1"
        assert params["scope"] == "project"
        assert params["limit"] == 10
        assert params["offset"] == 5
        assert params["sort_by"] == "name"
        assert params["sort_desc"] is False
        assert params["fields"] == {"priority": "high"}
        assert "modified_after" in params
        assert "created_after" in params

    def test_to_provider_params_empty(self):
        q = RecordQuery()
        params = q.to_provider_params()
        assert params == {}

    def test_to_provider_params_field_predicates_nested(self):
        q = RecordQuery(field_predicates={"color": "blue"})
        params = q.to_provider_params()
        assert "fields" in params
        assert params["fields"] == {"color": "blue"}
        assert "field_predicates" not in params
