"""Tests for the type registry -- explicit registration of record types.

Adapted from the skillit test suite. The original tests covered plugin_records
(SkillitSession, SkillitConfig) which are not available in flow-cli.
This version tests the registry mechanism using SkillRecord and manual
registration.
"""

from typing import ClassVar

from flow_sdk.fs_store import type_registry, Record
from flow_sdk.fs_store.record_types import RecordType, SkillitRecordType
from flow_sdk.fs_records.skill_record import SkillRecord


# ---------------------------------------------------------------------------
# Ensure SkillRecord is registered so tests below can find it.
# In the skillit repo this happens at import time via plugin_records;
# here we register explicitly since there is no plugin_records package.
# ---------------------------------------------------------------------------
type_registry.register(RecordType.SKILL, SkillRecord)


def test_skill_record_registered():
    assert type_registry.get(RecordType.SKILL) is SkillRecord


def test_get_unknown_returns_none():
    assert type_registry.get("nonexistent") is None


def test_contains():
    assert RecordType.SKILL in type_registry
    assert "nonexistent" not in type_registry


def test_get_all_types():
    all_types = type_registry.get_all_types()
    assert RecordType.SKILL in all_types


def test_get_returns_correct_class():
    cls = type_registry.get(RecordType.SKILL)
    record = cls(id="test-1")
    assert record.type == RecordType.SKILL


def test_register_and_retrieve_custom_type():
    """Test that arbitrary Record subclasses can be registered and retrieved."""

    class CustomRecord(Record):
        _record_type: ClassVar[str] = "custom_test"

        def __init__(self, **kwargs):
            kwargs.setdefault("type", "custom_test")
            super().__init__(**kwargs)

    type_registry.register("custom_test", CustomRecord)
    assert type_registry.get("custom_test") is CustomRecord
    assert "custom_test" in type_registry

    record = type_registry.get("custom_test")(id="c1")
    assert record.type == "custom_test"
    assert record.id == "c1"


def test_register_empty_type_name_is_no_op():
    """Registering with an empty type name should not add to the registry."""
    before_count = len(type_registry)
    type_registry.register("", Record)
    assert len(type_registry) == before_count
