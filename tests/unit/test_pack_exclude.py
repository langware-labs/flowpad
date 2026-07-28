"""A folder-backed asset ships verbatim — except what its type keeps home.

``TypeInfo.pack_exclude`` is the only per-type file policy in the bundle packer.
The motivating case: a task's inner ``spec.md`` is the owner's plan, and the
packer copies the task folder as-is, so every share of a task carried it —
directly contradicting what the task type documents.

Import order matters: ``register_all()`` must run before the entity modules, or
runtime-only TypeInfo fields read empty (see test_assignee_owned_fields).
"""

from __future__ import annotations

from flow_sdk.schema.type_info import register_all

register_all()

from flow_sdk.builtin.flow_message_bundle import _pack_ignore  # noqa: E402
from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: E402

FOLDER = ["task.md", "spec.md", "references", "__pycache__", "notes.md"]


def test_task_declares_the_plan_as_pack_excluded():
    assert SchemaRegistry.get("task").pack_exclude == ("spec.md",)


def test_a_task_folder_ships_without_its_plan():
    ignored = _pack_ignore("task", "/tasks/fix_login")("/tasks/fix_login", FOLDER)
    assert "spec.md" in ignored, "the plan must not ride the bundle"
    assert "__pycache__" in ignored, "global cruft still filtered"
    assert "task.md" not in ignored and "references" not in ignored


def test_a_nested_child_entity_with_the_same_filename_still_ships():
    """A ``spec`` entity parented to a task IS a ``spec.md``, one level down. The
    exclusion is root-only so the task's own plan stays home without dropping
    somebody else's entity that happens to live inside the folder."""
    ignore = _pack_ignore("task", "/tasks/fix_login")
    assert "spec.md" in ignore("/tasks/fix_login", FOLDER)
    assert "spec.md" not in ignore("/tasks/fix_login/agentic-assets/spec/plan", ["spec.md"])


def test_types_without_a_declaration_are_unchanged():
    """Only the global cruft list applies — `spec.md` is a legitimate file for
    the spec type, so the filter must not be global."""
    ignored = _pack_ignore("skill", "/skills/x")("/skills/x", FOLDER)
    assert ignored == {"__pycache__"}
    assert _pack_ignore(None, "/x")("/x", FOLDER) == {"__pycache__"}
