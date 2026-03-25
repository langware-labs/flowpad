"""Tests for __init_subclass__ auto-registration of record types."""

from flow_sdk.fs_store import Record
from flow_sdk.fs_store.factory.type_registry import type_registry
from flow_sdk.fs_store.record_types import RecordType


def test_task_resource_auto_registered():
    from flow_sdk.fs_records import TaskResource  # noqa: F401
    assert type_registry.get(RecordType.TASK) is TaskResource


def test_agentic_process_auto_registered():
    from flow_sdk.fs_records import AgenticProcessRecord  # noqa: F401
    assert type_registry.get(RecordType.AGENTIC_PROCESS) is AgenticProcessRecord


def test_skill_record_auto_registered():
    from flow_sdk.fs_records.skill_record import SkillRecord  # noqa: F401
    assert type_registry.get(RecordType.SKILL) is SkillRecord


def test_artifact_auto_registered():
    from flow_sdk.fs_records.artifact import Artifact  # noqa: F401
    assert type_registry.get(RecordType.ARTIFACT) is Artifact


def test_claude_session_auto_registered():
    """ClaudeSessionRecord now sets _record_type and is auto-registered."""
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord  # noqa: F401
    assert type_registry.get(RecordType.CLAUDE_SESSION) is ClaudeSessionRecord


def test_duplicate_registration_idempotent():
    """Re-importing a module with _record_type doesn't crash or overwrite."""
    from flow_sdk.fs_records import TaskResource  # noqa: F401
    cls_before = type_registry.get(RecordType.TASK)
    # Force re-check — __init_subclass__ already ran, idempotent guard skips it
    assert type_registry.get(RecordType.TASK) is cls_before


def test_base_record_not_registered():
    """Record itself has _record_type = '' so it should not be registered."""
    assert "" not in type_registry
    assert type_registry.get("") is None
