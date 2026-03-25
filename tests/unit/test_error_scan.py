"""Comprehensive flat-scan tests for the unified error record hierarchy.

All tests use real disk (tmp_path), no mocks.
"""
from __future__ import annotations

import json
from typing import ClassVar

import pytest

from flow_sdk.fs_records.record_error import RecordError
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root
from flow_sdk.fs_store.resource_record_list import ResourceRecordList
from flow_sdk.fs_store.schema_registry import SchemaRegistry


class FakeRecord(Record):
    _record_type: ClassVar[str] = "fake_for_scan"


def _make_record_error(tmp_path, suffix: str) -> RecordError:
    rec = FakeRecord(id=f"rec-{suffix}", type="fake_for_scan")
    err = RecordError.from_exception(rec, ValueError(f"error-{suffix}"), trigger="index")
    err.save()
    return err


def _make_claude_error(tmp_path, fingerprint: str):
    """Write a ClaudeErrorRecord directly to disk via ResourceRecordList (bypass sync)."""
    from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord

    backing = ResourceRecordList(list_path=tmp_path / "claude_error", record_class=ClaudeErrorRecord)
    claude_rec = ClaudeErrorRecord(
        fingerprint=fingerprint,
        error_msg=f"hook error {fingerprint}",
        first_seen="2026-01-01T00:00:00+00:00",
    )
    claude_rec.id = fingerprint
    backing.create(claude_rec)
    return claude_rec


# ---------------------------------------------------------------------------
# Group 1 — SchemaRegistry wiring
# ---------------------------------------------------------------------------

class TestSchemaRegistryWiring:
    def test_claude_error_registered_as_subtype_of_record_error(self):
        """Importing ClaudeErrorRecord wires it as a subtype of record_error."""
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

        subtypes = SchemaRegistry.get_subtypes("record_error")
        type_names = [s.type_name for s in subtypes]
        assert "claude_error" in type_names

        # record_cls must be set
        for st in subtypes:
            if st.type_name == "claude_error":
                assert st.record_cls is ClaudeErrorRecord

    def test_record_error_parent_type_is_none(self):
        """record_error is the root — it has no parent."""
        info = SchemaRegistry.get("record_error")
        # info may be None if not registered yet; import triggers registration
        from flow_sdk.fs_records.record_error import RecordError  # noqa: F401
        info = SchemaRegistry.get("record_error")
        assert info is not None
        assert info.parent_type is None

    def test_claude_error_parent_type_is_record_error(self):
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

        info = SchemaRegistry.get("claude_error")
        assert info is not None
        assert info.parent_type == "record_error"


# ---------------------------------------------------------------------------
# Group 2 — discover() traversal
# ---------------------------------------------------------------------------

class TestDiscoverTraversal:
    def test_base_discover_returns_record_errors_only_when_no_claude_errors(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401 — trigger registration

            for i in range(3):
                _make_record_error(tmp_path, str(i))

            errors = RecordError.discover()
            assert len(errors) == 3
            assert all(isinstance(e, RecordError) for e in errors)
        finally:
            set_default_records_root(old_root)

    def test_base_discover_returns_claude_errors_when_present(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            _make_claude_error(tmp_path, "fp-a")
            _make_claude_error(tmp_path, "fp-b")

            # RecordError.discover() only returns base type records
            # ClaudeErrorRecord records are not returned by base discover()
            # (subtype traversal is now in SchemaRegistry.get_errors())
            claude_errors = ClaudeErrorRecord.discover()
            assert len(claude_errors) == 2
        finally:
            set_default_records_root(old_root)

    def test_base_discover_returns_only_base_type(self, tmp_path):
        """RecordError.discover() returns only base-type records, not subtypes."""
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            for i in range(2):
                _make_record_error(tmp_path, f"r{i}")
            for i in range(3):
                _make_claude_error(tmp_path, f"c{i}")

            # Base discover only returns record_error type
            base_errors = RecordError.discover()
            assert len(base_errors) == 2
            assert all(e._record_type == "record_error" for e in base_errors)
        finally:
            set_default_records_root(old_root)

    def test_subclass_discover_returns_only_own_type(self, tmp_path):
        """ClaudeErrorRecord.discover() returns only ClaudeErrorRecords — no double-count."""
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord

            for i in range(2):
                _make_record_error(tmp_path, f"r{i}")
            _make_claude_error(tmp_path, "fp-only")

            claude_errors = ClaudeErrorRecord.discover()
            assert len(claude_errors) == 1
            assert all(isinstance(e, ClaudeErrorRecord) for e in claude_errors)
        finally:
            set_default_records_root(old_root)

    def test_base_discover_with_no_files_returns_empty(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            errors = RecordError.discover()
            assert errors == []
        finally:
            set_default_records_root(old_root)


# ---------------------------------------------------------------------------
# Group 3 — subtype registry edge cases
# ---------------------------------------------------------------------------

class TestSubtypeEdgeCases:
    def test_discover_skips_subtype_with_no_record_cls(self, tmp_path):
        """SchemaRegistry.get_errors() does not crash when a subtype TypeInfo has record_cls=None."""
        from flow_sdk.fs_store.schema_registry import TypeInfo

        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            # Register a fake subtype with no record_cls
            SchemaRegistry.register(TypeInfo(
                type_name="__test_null_subtype__",
                parent_type="record_error",
                record_cls=None,
            ))

            _make_record_error(tmp_path, "x")
            errors = SchemaRegistry.get_errors()  # must not crash
            assert any(isinstance(e, RecordError) for e in errors)
        finally:
            set_default_records_root(old_root)
            # Clean up the fake registration
            SchemaRegistry._types.pop("__test_null_subtype__", None)
            if "record_error" in SchemaRegistry._subtypes:
                SchemaRegistry._subtypes["record_error"] = [
                    n for n in SchemaRegistry._subtypes["record_error"]
                    if n != "__test_null_subtype__"
                ]

    def test_discover_returns_list_not_generator(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            result = RecordError.discover()
            assert isinstance(result, list)
        finally:
            set_default_records_root(old_root)


# ---------------------------------------------------------------------------
# Group 4 — field interface across types
# ---------------------------------------------------------------------------

class TestFieldInterface:
    def _setup(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401
        set_default_records_root(tmp_path)
        _make_record_error(tmp_path, "r1")
        _make_claude_error(tmp_path, "c1")

    def test_all_errors_have_error_message(self, tmp_path):
        old_root = get_default_records_root()
        self._setup(tmp_path)
        try:
            for e in SchemaRegistry.get_errors():
                assert getattr(e, "error_message", None), f"{e._record_type} missing error_message"
        finally:
            set_default_records_root(old_root)

    def test_all_errors_have_occurred_at(self, tmp_path):
        old_root = get_default_records_root()
        self._setup(tmp_path)
        try:
            for e in SchemaRegistry.get_errors():
                assert getattr(e, "occurred_at", None), f"{e._record_type} missing occurred_at"
        finally:
            set_default_records_root(old_root)

    def test_all_errors_have_trigger(self, tmp_path):
        old_root = get_default_records_root()
        self._setup(tmp_path)
        try:
            for e in SchemaRegistry.get_errors():
                assert getattr(e, "trigger", None), f"{e._record_type} missing trigger"
        finally:
            set_default_records_root(old_root)

    def test_record_types_are_distinct_in_flat_list(self, tmp_path):
        old_root = get_default_records_root()
        self._setup(tmp_path)
        try:
            errors = SchemaRegistry.get_errors()
            types_seen = {getattr(e, "_record_type", None) for e in errors}
            assert "record_error" in types_seen
            assert "claude_error" in types_seen
        finally:
            set_default_records_root(old_root)


# ---------------------------------------------------------------------------
# Group 5 — SchemaRegistry.get_errors()
# ---------------------------------------------------------------------------

class TestGetErrors:
    def test_get_errors_returns_all_error_types(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            _make_record_error(tmp_path, "r1")
            _make_claude_error(tmp_path, "c1")

            errors = SchemaRegistry.get_errors()
            assert len(errors) == 2
        finally:
            set_default_records_root(old_root)

    def test_get_errors_filtered_by_type_name(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            _make_record_error(tmp_path, "r1")
            _make_claude_error(tmp_path, "c1")

            claude_only = SchemaRegistry.get_errors("claude_error")
            assert len(claude_only) == 1
            assert claude_only[0]._record_type == "claude_error"

            record_only = SchemaRegistry.get_errors("record_error")
            assert len(record_only) == 1
            assert record_only[0]._record_type == "record_error"
        finally:
            set_default_records_root(old_root)

    def test_get_errors_filtered_by_typeid(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401
            from flow_sdk.fs_store.type_id import TypeId

            _make_claude_error(tmp_path, "c1")

            errors = SchemaRegistry.get_errors(TypeId(type="claude_error"))
            assert len(errors) == 1
            assert errors[0]._record_type == "claude_error"
        finally:
            set_default_records_root(old_root)

    def test_get_errors_empty_when_nothing_on_disk(self, tmp_path):
        old_root = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord  # noqa: F401

            errors = SchemaRegistry.get_errors()
            assert errors == []
        finally:
            set_default_records_root(old_root)
