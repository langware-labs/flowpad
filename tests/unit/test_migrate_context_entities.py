"""Smoke test for migration_2026_05_consolidate_context_entities.

Superseded: the unified ``context_entities`` field has been split into
``shared_context_entities`` / ``private_context_entities_``. The migration
that this test exercises remains on disk for historical reference but is
no longer wired into the current data model. The test is skipped at module
load to keep the suite green without deleting the migration code.
"""

import pytest

pytest.skip(
    "Superseded by the context_entities split — see "
    "plan add-context-entity-typeid-kind-remove-melodic-meadow.md",
    allow_module_level=True,
)

from flow_sdk.migrations.migration_2026_05_consolidate_context_entities import (  # noqa: E402
    _planned_changes_for_conversation,
    _planned_changes_for_flow_message,
    _planned_changes_for_room,
    _planned_changes_for_spec,
    _planned_changes_for_task,
)


def test_task_promotes_spec_and_conversation_into_context_entities():
    raw = {
        "id": "task-uuid",
        "spec_id": "spec-uuid",
        "conversation_id": "conv-uuid",
        "links": {"a": "b"},
    }
    new_ctx, dropped = _planned_changes_for_task(raw)
    assert "spec-spec-uuid" in new_ctx
    assert "conversation-conv-uuid" in new_ctx
    assert set(dropped) == {"spec_id", "conversation_id", "links"}


def test_task_idempotent_when_already_migrated():
    raw = {
        "id": "task-uuid",
        "context_entities": ["spec-spec-uuid", "conversation-conv-uuid"],
    }
    new_ctx, dropped = _planned_changes_for_task(raw)
    assert new_ctx == ["spec-spec-uuid", "conversation-conv-uuid"]
    assert dropped == []


def test_spec_promotes_plan_id():
    raw = {"id": "s", "plan_id": "p1"}
    new_ctx, dropped = _planned_changes_for_spec(raw)
    assert new_ctx == ["plan-p1"]
    assert dropped == ["plan_id"]


def test_spec_no_plan_id_is_noop():
    raw = {"id": "s"}
    new_ctx, dropped = _planned_changes_for_spec(raw)
    assert new_ctx == []
    assert dropped == []


def test_conversation_promotes_task_id():
    raw = {"id": "c", "task_id": "t1"}
    new_ctx, dropped = _planned_changes_for_conversation(raw)
    assert new_ctx == ["task-t1"]
    assert dropped == ["task_id"]


def test_flow_message_renames_context_to_context_entities():
    raw = {"id": "m", "context": ["task-t1", "conversation-c1"]}
    new_ctx, dropped = _planned_changes_for_flow_message(raw)
    assert new_ctx == ["task-t1", "conversation-c1"]
    assert dropped == ["context"]


def test_flow_message_already_renamed_is_noop():
    raw = {"id": "m", "context_entities": ["task-t1"]}
    new_ctx, dropped = _planned_changes_for_flow_message(raw)
    assert new_ctx == ["task-t1"]
    assert dropped == []


def test_room_promotes_agentic_process_ids():
    raw = {"id": "r", "agentic_process_ids": ["p1", "p2"]}
    new_ctx, dropped = _planned_changes_for_room(raw)
    assert new_ctx == ["agentic_process-p1", "agentic_process-p2"]
    assert dropped == ["agentic_process_ids"]


def test_room_dedupes_against_existing_context():
    raw = {
        "id": "r",
        "context_entities": ["agentic_process-p1"],
        "agentic_process_ids": ["p1", "p2"],
    }
    new_ctx, dropped = _planned_changes_for_room(raw)
    assert new_ctx == ["agentic_process-p1", "agentic_process-p2"]
    assert dropped == ["agentic_process_ids"]
