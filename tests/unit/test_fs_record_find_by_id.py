"""Tests for FSRecord.find_by_id — type-agnostic lookup across records_root.

The autouse ``isolated_records_root`` fixture (tests/conftest.py) redirects the
records root to a per-test temp dir, so each test starts from an empty store.
"""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.schema.types import EntityType


def test_find_by_id_single_match_across_several_types():
    """With distinct ids spread over several types, each id resolves to its record."""
    FSRecord(str(EntityType.PROJECT), "proj-1", name="Proj").save()
    FSRecord(str(EntityType.TASK), "task-1", name="Task").save()
    FSRecord(str(EntityType.SKILL), "skill-1", name="Skill").save()

    proj = FSRecord.find_by_id("proj-1")
    assert proj is not None
    assert proj.type == str(EntityType.PROJECT)
    assert proj.id == "proj-1"
    assert proj.name == "Proj"

    task = FSRecord.find_by_id("task-1")
    assert task is not None
    assert task.type == str(EntityType.TASK)
    assert task.id == "task-1"

    skill = FSRecord.find_by_id("skill-1")
    assert skill is not None
    assert skill.type == str(EntityType.SKILL)
    assert skill.id == "skill-1"


def test_find_by_id_zero_match_returns_none():
    """An id that no type owns returns None."""
    FSRecord(str(EntityType.PROJECT), "proj-1").save()
    assert FSRecord.find_by_id("does-not-exist") is None


def test_find_by_id_collision_across_types_raises():
    """The same id under two different types is ambiguous → ValueError naming both."""
    FSRecord(str(EntityType.PROJECT), "shared-id").save()
    FSRecord(str(EntityType.TASK), "shared-id").save()

    with pytest.raises(ValueError) as excinfo:
        FSRecord.find_by_id("shared-id")
    msg = str(excinfo.value)
    assert str(EntityType.PROJECT) in msg
    assert str(EntityType.TASK) in msg


def test_find_by_id_empty_root_returns_none():
    """With nothing ever saved, the records root may not exist → None, no error."""
    assert FSRecord.find_by_id("anything") is None
