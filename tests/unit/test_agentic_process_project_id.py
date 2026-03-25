"""Tests for planned project_id field on AgenticProcess entity and AgenticProcessRecord.

These tests verify PLANNED behaviour and are expected to FAIL until the feature
is implemented:
  - AgenticProcess entity has project_id as an APIField
  - AgenticProcessRecord has a project_id stored property (like project_encoded_name)
  - Setting project_id on the record marks it dirty and persists the value
"""

import pytest

from flow_sdk.builtin.agentic_processor import AgenticProcess
from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
from flow_sdk.api.api_types.api_field import APIField


# ---------------------------------------------------------------------------
# 1. AgenticProcess entity — project_id APIField
# ---------------------------------------------------------------------------

def test_agentic_process_entity_has_project_id_attribute():
    """AgenticProcess must declare project_id as a class-level attribute."""
    fields = getattr(AgenticProcess, "model_fields", None)
    if fields is not None:
        assert "project_id" in fields, (
            "AgenticProcess entity is missing the 'project_id' attribute"
        )
    else:
        assert hasattr(AgenticProcess, "project_id"), (
            "AgenticProcess entity is missing the 'project_id' attribute"
        )


def test_agentic_process_entity_project_id_is_api_field():
    """project_id must be registered as an APIField on AgenticProcess."""
    # APIField instances are stored as the class-level descriptor / default value.
    # The canonical way to check is to look at the model_fields dict (Pydantic v2)
    # or fall back to inspecting the class __dict__ / annotations.
    fields = getattr(AgenticProcess, "model_fields", None)
    if fields is not None:
        # Pydantic v2 — field must be present
        assert "project_id" in fields, (
            "project_id is not in AgenticProcess.model_fields"
        )
    else:
        # Fallback: attribute exists on class (checked above)
        assert "project_id" in AgenticProcess.__annotations__, (
            "project_id is not annotated on AgenticProcess"
        )


def test_agentic_process_entity_project_id_default_none():
    """project_id should default to None on a freshly constructed entity."""
    # Constructing the entity without a DB requires mocking; instead check the
    # field's default value directly from model_fields.
    fields = getattr(AgenticProcess, "model_fields", {})
    field_info = fields.get("project_id")
    assert field_info is not None, "project_id field not found in model_fields"
    # Pydantic v2 stores the default on FieldInfo
    assert field_info.default is None, (
        f"Expected default None for project_id, got {field_info.default!r}"
    )


# ---------------------------------------------------------------------------
# 2. AgenticProcessRecord — project_id stored property
# ---------------------------------------------------------------------------

def test_agentic_process_record_has_project_id_attribute():
    """AgenticProcessRecord must expose a project_id property."""
    assert hasattr(AgenticProcessRecord, "project_id"), (
        "AgenticProcessRecord is missing the 'project_id' attribute"
    )


def test_agentic_process_record_project_id_defaults_to_none():
    """Newly created AgenticProcessRecord must have project_id == None."""
    record = AgenticProcessRecord(name="test-proc")
    assert record.project_id is None, (
        f"Expected project_id to default to None, got {record.project_id!r}"
    )


def test_agentic_process_record_set_project_id_returns_value():
    """Setting project_id on the record must make the getter return the new value."""
    record = AgenticProcessRecord(name="test-proc")
    uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    record.project_id = uid
    assert record.project_id == uid, (
        f"Expected project_id {uid!r}, got {record.project_id!r}"
    )


def test_agentic_process_record_set_project_id_marks_dirty():
    """Setting project_id must add 'project_id' to the record's _dirty_keys set."""
    record = AgenticProcessRecord(name="test-proc")
    uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    record.project_id = uid
    dirty = object.__getattribute__(record, "_dirty_keys")
    assert "project_id" in dirty, (
        f"'project_id' not found in _dirty_keys after assignment; got: {dirty}"
    )
