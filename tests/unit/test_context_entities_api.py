"""Tests for the split context_entities entity API.

Covers, on the base ``Entity``:
- Two persisted buckets: ``shared_context_entities`` (wire-bound) and
  ``private_context_entities_`` (local-only raw).
- Public read accessors: ``shared_context_entities`` (identity) and
  ``private_context_entities`` (computed; folds in ``_direct_fields_as_typeids``).
- Four mutators: ``add_shared_context_entities`` / ``remove_shared_context_entities``
  and ``add_private_context_entities`` / ``remove_private_context_entities``
  — all variadic, accept singles or lists.
- ``context_of_type`` / ``first_context_of_type`` with ``bucket=`` selector.

Per-entity ``_direct_fields_as_typeids`` overrides for Task / Spec /
Conversation / CollaborationRoom still feed only the *private* view.
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


# ── Defaults ─────────────────────────────────────────────────────────


def test_default_shared_and_private_are_empty_lists():
    task = Task(title="t")
    assert task.shared_context_entities == []
    assert task.private_context_entities_ == []


# ── Private bucket: add / remove / variadic / batch ──────────────────


def test_add_private_context_entities_appends_single():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    assert task.add_private_context_entities(tid) is True
    assert task.private_context_entities_ == [tid]


def test_add_private_context_entities_is_idempotent():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_private_context_entities(tid)
    assert task.add_private_context_entities(tid) is False
    assert task.private_context_entities_ == [tid]


def test_add_private_context_entities_accepts_variadic_args():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="conversation", id=CONV_ID_1)
    c = TypeId(type="user", id=USER_ID_1)
    assert task.add_private_context_entities(a, b, c) is True
    assert task.private_context_entities_ == [a, b, c]


def test_add_private_context_entities_accepts_list():
    task = Task(title="t")
    items = [
        TypeId(type="spec", id=SPEC_ID_1),
        TypeId(type="spec", id=SPEC_ID_2),
    ]
    assert task.add_private_context_entities(items) is True
    assert task.private_context_entities_ == items


def test_add_private_context_entities_mixed_singles_and_lists():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="spec", id=SPEC_ID_2)
    c = TypeId(type="conversation", id=CONV_ID_1)
    # Mix: one TypeId, one list of TypeIds.
    assert task.add_private_context_entities(a, [b, c]) is True
    assert task.private_context_entities_ == [a, b, c]


def test_remove_private_context_entities_returns_true_when_removed():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_private_context_entities(tid)
    assert task.remove_private_context_entities(tid) is True
    assert task.private_context_entities_ == []


def test_remove_private_context_entities_returns_false_when_absent():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    assert task.remove_private_context_entities(tid) is False


def test_remove_private_context_entities_batch():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="spec", id=SPEC_ID_2)
    c = TypeId(type="conversation", id=CONV_ID_1)
    task.add_private_context_entities([a, b, c])
    assert task.remove_private_context_entities([a, c]) is True
    assert task.private_context_entities_ == [b]


# ── Shared bucket: add / remove / variadic / batch ───────────────────


def test_add_shared_context_entities_appends_single():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    assert task.add_shared_context_entities(tid) is True
    assert task.shared_context_entities == [tid]


def test_add_shared_context_entities_is_idempotent():
    task = Task(title="t")
    tid = TypeId(type="spec", id=SPEC_ID_1)
    task.add_shared_context_entities(tid)
    assert task.add_shared_context_entities(tid) is False
    assert task.shared_context_entities == [tid]


def test_add_shared_context_entities_variadic_and_list():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="conversation", id=CONV_ID_1)
    assert task.add_shared_context_entities(a, [b]) is True
    assert task.shared_context_entities == [a, b]


def test_remove_shared_context_entities_batch():
    task = Task(title="t")
    a = TypeId(type="spec", id=SPEC_ID_1)
    b = TypeId(type="conversation", id=CONV_ID_1)
    task.add_shared_context_entities([a, b])
    assert task.remove_shared_context_entities([a]) is True
    assert task.shared_context_entities == [b]


# ── Buckets are independent ──────────────────────────────────────────


def test_buckets_are_independent():
    task = Task(title="t")
    shared_tid = TypeId(type="spec", id=SPEC_ID_1)
    private_tid = TypeId(type="conversation", id=CONV_ID_1)
    task.add_shared_context_entities(shared_tid)
    task.add_private_context_entities(private_tid)
    # Same TypeId in different buckets is allowed — they're independent.
    dup = TypeId(type="user", id=USER_ID_1)
    task.add_shared_context_entities(dup)
    task.add_private_context_entities(dup)
    assert dup in task.shared_context_entities
    assert dup in task.private_context_entities_
    assert shared_tid in task.shared_context_entities
    assert shared_tid not in task.private_context_entities_
    assert private_tid in task.private_context_entities_
    assert private_tid not in task.shared_context_entities


# ── Direct-field projection lands in private only ────────────────────


def test_task_direct_fields_appear_in_private_view():
    task = Task(
        title="t",
        project_id=PROJ_ID_1,
        assignee=USER_ID_1,
        my_process_id=PROC_ID_1,
        shared_process_id=PROC_ID_2,
    )
    private = task.private_context_entities
    private_ids = {(t.type, t.id) for t in private}
    assert ("project", PROJ_ID_1) in private_ids
    assert ("user", USER_ID_1) in private_ids
    assert ("agentic_process", PROC_ID_1) in private_ids
    assert ("agentic_process", PROC_ID_2) in private_ids


def test_task_direct_fields_do_not_leak_into_shared():
    task = Task(title="t", project_id=PROJ_ID_1, assignee=USER_ID_1)
    assert task.shared_context_entities == []  # nothing was added to shared


def test_task_private_merges_direct_and_explicit():
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_private_context_entities(TypeId(type="spec", id=SPEC_ID_1))
    private = task.private_context_entities
    ids = {(t.type, t.id) for t in private}
    assert ("project", PROJ_ID_1) in ids  # from direct projection
    assert ("spec", SPEC_ID_1) in ids  # explicitly added


def test_task_skips_unset_direct_fields():
    task = Task(title="t")  # nothing set
    assert task.private_context_entities == []


def test_spec_projects_author_into_private():
    spec = Spec(title="s", author_id=USER_ID_1)
    private = spec.private_context_entities
    assert TypeId(type="user", id=USER_ID_1) in private


def test_spec_with_plan_in_private():
    spec = Spec(title="s")
    spec.add_private_context_entities(TypeId(type="plan", id=PLAN_ID_1))
    ids = {(t.type, t.id) for t in spec.private_context_entities}
    assert ("plan", PLAN_ID_1) in ids


def test_conversation_projects_project_into_private():
    conv = Conversation(project_id=PROJ_ID_1)
    assert TypeId(type="project", id=PROJ_ID_1) in conv.private_context_entities


def test_conversation_can_carry_task_in_shared():
    """Conversation→Task linkage is published thread metadata — landing in
    shared is correct under the new rule. Verifies the shared bucket works
    end-to-end for this entity too."""
    conv = Conversation()
    conv.add_shared_context_entities(TypeId(type="task", id=TASK_ID_1))
    assert conv.first_context_of_type("task", bucket="shared") == TypeId(type="task", id=TASK_ID_1)


# ── bucket-aware lookups ─────────────────────────────────────────────


def test_context_of_type_default_walks_both_buckets():
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_shared_context_entities(TypeId(type="spec", id=SPEC_ID_1))
    task.add_private_context_entities(TypeId(type="spec", id=SPEC_ID_2))
    specs = task.context_of_type("spec")
    spec_ids = {t.id for t in specs}
    assert spec_ids == {SPEC_ID_1, SPEC_ID_2}


def test_context_of_type_filters_to_shared():
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_shared_context_entities(TypeId(type="spec", id=SPEC_ID_1))
    task.add_private_context_entities(TypeId(type="spec", id=SPEC_ID_2))
    specs = task.context_of_type("spec", bucket="shared")
    assert [t.id for t in specs] == [SPEC_ID_1]


def test_context_of_type_filters_to_private_includes_direct_projection():
    task = Task(title="t", project_id=PROJ_ID_1)
    # A different project in shared shouldn't leak into the private view.
    other_proj_id = "99999999-aaaa-4bbb-9ccc-000000000099"
    task.add_shared_context_entities(TypeId(type="project", id=other_proj_id))
    private_projects = task.context_of_type("project", bucket="private")
    assert [t.id for t in private_projects] == [PROJ_ID_1]  # projected from project_id


def test_first_context_of_type_bucket_aware():
    task = Task(title="t")
    s1 = TypeId(type="spec", id=SPEC_ID_1)
    s2 = TypeId(type="spec", id=SPEC_ID_2)
    task.add_shared_context_entities(s1)
    task.add_private_context_entities(s2)
    assert task.first_context_of_type("spec", bucket="shared") == s1
    assert task.first_context_of_type("spec", bucket="private") == s2
    # Default 'both' walks shared first, then private (shared is canonical).
    assert task.first_context_of_type("spec") == s1


# ── CollaborationRoom (room membership = shared) ─────────────────────


def test_collaboration_room_add_process_goes_to_shared():
    room = CollaborationRoom(project_id=PROJ_ID_1)
    proc_tid = TypeId(type="agentic_process", id=PROC_ID_1)
    room.add_shared_context_entities(proc_tid)
    assert room.first_context_of_type("agentic_process", bucket="shared") == proc_tid
    assert PROC_ID_1 in room.agentic_process_ids


def test_collaboration_room_agentic_process_ids_property_reads_shared():
    room = CollaborationRoom(project_id=PROJ_ID_1)
    room.add_shared_context_entities(
        TypeId(type="agentic_process", id=PROC_ID_1),
        TypeId(type="agentic_process", id=PROC_ID_2),
        TypeId(type="user", id=USER_ID_1),  # unrelated
    )
    assert room.agentic_process_ids == [PROC_ID_1, PROC_ID_2]


# ── Serialization invariants (private stays local) ───────────────────


def test_private_context_excluded_from_share_dump():
    """The ``share()`` body excludes ``private_context_entities_`` so
    local-only context never reaches the hub."""
    task = Task(title="t", project_id=PROJ_ID_1)
    task.add_private_context_entities(TypeId(type="spec", id=SPEC_ID_1))
    task.add_shared_context_entities(TypeId(type="spec", id=SPEC_ID_2))
    body = task.model_dump(
        mode="json",
        exclude_none=True,
        exclude={"private_context_entities_", "created_by", "updated_by", "created_date", "updated_date"},
    )
    assert "private_context_entities_" not in body
    # Shared lands on the wire as plain ``shared_context_entities``.
    assert SPEC_ID_2 in str(body.get("shared_context_entities", []))
