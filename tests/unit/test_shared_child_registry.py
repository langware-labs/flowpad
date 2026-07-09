"""shared_child: registry flag drives the shared-context catch-up pull, replacing
the old hardcoded ``_SHARED_CHILD_TYPES`` tuple. Mirrors the parent_share_on_default
registry-flag pattern. No mocks; pure registry."""

from __future__ import annotations

import flow_sdk.models.entities  # noqa: F401 — attach entity_cls to every TypeInfo
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all


def setup_function() -> None:
    register_all()


def test_comment_is_flagged_shared_child():
    assert SchemaRegistry.get("comment").shared_child is True
    # A non-child api_visible type is not enrolled.
    assert SchemaRegistry.get("project").shared_child is False


def test_get_shared_child_types_includes_comment():
    assert "comment" in SchemaRegistry.get_shared_child_types()


def test_hardcoded_tuple_is_gone():
    """The catch-up no longer carries a hardcoded child-type list."""
    from flow_sdk.app.actions import flow_message_action as fma

    assert not hasattr(fma, "_SHARED_CHILD_TYPES")


def test_new_shared_child_type_enrolls_without_touching_catchup():
    """A second type enrolls for free by flipping its registry flag — the catch-up
    code (``get_shared_child_types``) reads the flag dynamically, so no sync-code
    edit is needed to onboard a new shareable child type."""
    info = SchemaRegistry.get("project")  # any api_visible entity type, not a shared_child
    assert info.entity_cls is not None
    assert "project" not in SchemaRegistry.get_shared_child_types()
    info.shared_child = True
    try:
        assert "project" in SchemaRegistry.get_shared_child_types()
    finally:
        info.shared_child = False  # restore the shared singleton state
    assert "project" not in SchemaRegistry.get_shared_child_types()
