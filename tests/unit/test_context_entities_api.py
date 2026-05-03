"""Tests for the unified context_entities entity API.

Covers:
- ``Entity.context_entities`` field default
- ``add_context_entity`` (idempotent, mutates state)
- ``remove_context_entity`` (returns true/false)
- ``context_entities_full`` getter (merges ``_direct_fields_as_typeids``
  projection with the persisted list)
- Per-entity ``_direct_fields_as_typeids`` overrides for Task / Spec /
  Conversation / CollaborationRoom
"""

from flow_sdk.builtin.collaboration_room import CollaborationRoom
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.db.drivers.db_base_record import TypeId


# Reusable UUIDs (TypeId requires a proper uuid format).
SPEC_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000001"
SPEC_ID_2 = "22222222-aaaa-4bbb-9ccc-000000000002"
CONV_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000010"
TASK_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000020"
PROJ_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000030"
USER_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000040"
PROC_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000050"
PROC_ID_2 = "22222222-aaaa-4bbb-9ccc-000000000051"
PLAN_ID_1 = "11111111-aaaa-4bbb-9ccc-000000000060"


# ── Base API ─────────────────────────────────────────────────────────


def test_default_context_entities_is_empty_list():
    task = Task(title="t")
    assert task.context_entities == []


def test_add_context_entity_appends():
    task = Task(title="t")
    spec_tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_context_entity(spec_tid)
    assert task.context_entities == [spec_tid]


def test_add_context_entity_is_idempotent():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_context_entity(tid)
    task.add_context_entity(tid)  # no-op
    assert task.context_entities == [tid]


def test_add_context_entity_preserves_order():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="conversation", id=CONV_ID_1)
    c = TypeId(type="user", id=USER_ID_1)
    task.add_context_entity(a)
    task.add_context_entity(b)
    task.add_context_entity(c)
    assert task.context_entities == [a, b, c]


def test_remove_context_entity_returns_true_when_removed():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_context_entity(tid)
    assert task.remove_context_entity(tid) is True
    assert task.context_entities == []


def test_remove_context_entity_returns_false_when_absent():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    assert task.remove_context_entity(tid) is False


def test_context_of_type_filters():
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_1))
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_2))
    task.add_context_entity(TypeId(type="conversation", id=CONV_ID_1))
    specs = task.context_of_type("spec")
    assert {t.id for t in specs} == {SPEC_ID_1, SPEC_ID_2}


def test_first_context_of_type_returns_first_or_none():
    task = Task(title="t")
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_1))
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_2))
    first = task.first_context_of_type("spec")
    assert first is not None and first.id == SPEC_ID_1
    assert task.first_context_of_type("plan") is None


# ── Per-entity direct projections ────────────────────────────────────


def test_task_projects_project_assignee_and_processes():
    task = Task(
        title="t",
        project_id=PROJ_ID_1,
        assignee=USER_ID_1,
        my_process_id=PROC_ID_1,
        shared_process_id=PROC_ID_2,
    )
    full = task.context_entities_full
    types_ids = {(t.type, t.id) for t in full}
    assert ("project", PROJ_ID_1) in types_ids
    assert ("user", USER_ID_1) in types_ids
    assert ("agentic_process", PROC_ID_1) in types_ids
    assert ("agentic_process", PROC_ID_2) in types_ids


def test_task_full_merges_direct_and_private():
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_1))
    full = task.context_entities_full
    types_ids = {(t.type, t.id) for t in full}
    # Both direct projection AND private array are present
    assert ("project", PROJ_ID_1) in types_ids
    assert ("spec", SPEC_ID_1) in types_ids


def test_task_skips_unset_direct_fields():
    task = Task(title="t")  # nothing set
    assert task.context_entities_full == []


def test_spec_projects_author():
    spec = Spec(title="s", author_id=USER_ID_1)
    full = spec.context_entities_full
    assert TypeId(type="user", id=USER_ID_1) in full


def test_spec_with_plan_in_context():
    spec = Spec(title="s")
    spec.add_context_entity(TypeId(type="plan", id=PLAN_ID_1))
    full = spec.context_entities_full
    types_ids = {(t.type, t.id) for t in full}
    assert ("plan", PLAN_ID_1) in types_ids


def test_conversation_projects_project():
    conv = Conversation(project_id=PROJ_ID_1)
    full = conv.context_entities_full
    assert TypeId(type="project", id=PROJ_ID_1) in full


def test_conversation_with_task_in_context():
    conv = Conversation()
    conv.add_context_entity(TypeId(type="task", id=TASK_ID_1))
    assert conv.first_context_of_type("task") == TypeId(type="task", id=TASK_ID_1)


def test_collaboration_room_add_process_via_context():
    """``add_process`` (the async wrapper) calls ``add_context_entity``
    underneath; verify the underlying mutation works directly."""
    room = CollaborationRoom(project_id=PROJ_ID_1)
    proc_tid = TypeId(type="agentic_process", id=PROC_ID_1)
    room.add_context_entity(proc_tid)
    assert room.first_context_of_type("agentic_process") == proc_tid
    assert PROC_ID_1 in room.agentic_process_ids


def test_collaboration_room_agentic_process_ids_property_is_derived():
    room = CollaborationRoom(project_id=PROJ_ID_1)
    room.add_context_entity(TypeId(type="agentic_process", id=PROC_ID_1))
    room.add_context_entity(TypeId(type="agentic_process", id=PROC_ID_2))
    room.add_context_entity(TypeId(type="user", id=USER_ID_1))  # unrelated, ignored
    assert room.agentic_process_ids == [PROC_ID_1, PROC_ID_2]


# ── Direct projection invariants ─────────────────────────────────────


def test_direct_projection_is_read_only_via_full_getter():
    """Mutating ``context_entities`` must not silently strip direct projections.
    The dynamic ``context_entities_full`` is the source of truth for chip
    rendering; the private list is only the persisted slot."""
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_context_entity(TypeId(type="spec", id=SPEC_ID_1))
    # Project is in full, NOT in the private list.
    assert TypeId(type="project", id=PROJ_ID_1) in task.context_entities_full
    assert TypeId(type="project", id=PROJ_ID_1) not in task.context_entities
    # Spec is in BOTH full and private.
    assert TypeId(type="spec", id=SPEC_ID_1) in task.context_entities
    assert TypeId(type="spec", id=SPEC_ID_1) in task.context_entities_full
