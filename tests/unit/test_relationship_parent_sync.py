"""Tests for RelationshipRecord parent/child sync on save/delete."""

from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest

from flow_sdk.fs_store import Record, RecordRef
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root, _DATA_JSON
from flow_sdk.fs_records.relationship import RelationshipRecord


@pytest.fixture()
def tmp_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _create_parent_on_disk(tmp_path: Path) -> tuple[Record, RecordRef]:
    """Create a parent record on disk at its canonical records_root location."""
    from flow_sdk.fs_store.record import get_default_records_root
    parent = Record(id="parent-1", type="task", name="Parent Task")
    parent.save()  # writes to records_root / "task" / "task-@parent-1"
    parent_dir = Path(parent.path)
    ref = RecordRef(id="parent-1", type="task", path=str(parent_dir))
    return parent, ref


def _make_child_ref() -> RecordRef:
    return RecordRef(id="child-1", type="task", path="/tmp/fake/child-1")


def _reload_parent(parent_dir: Path) -> Record:
    """Re-read parent from disk to verify changes persisted."""
    return Record.init_record(parent_dir)


def _setup_rel_on_disk(rel: RelationshipRecord, tmp_records_root: Path) -> None:
    """Set up a relationship record on disk so super().save() works."""
    safe_id = rel.id.replace(":", "_")
    rel_dir = tmp_records_root / "child" / safe_id
    rel_dir.mkdir(parents=True, exist_ok=True)
    rel_file = rel_dir / _DATA_JSON
    rel.path = str(rel_dir)
    rel.source_file = str(rel_file)
    rel.save_record_json(rel_file)


def test_save_adds_to_parent_children_refs(tmp_records_root):
    """save() should add to_ref to parent's children_refs."""
    parent, parent_ref = _create_parent_on_disk(tmp_records_root)
    child_ref = _make_child_ref()
    rel = RelationshipRecord.child(parent_ref, child_ref)
    _setup_rel_on_disk(rel, tmp_records_root)

    rel.save()

    reloaded = _reload_parent(Path(parent_ref.path))
    children = reloaded.children_refs
    assert any(c.id == "child-1" and c.type == "task" for c in children)


def test_delete_removes_from_parent_children_refs(tmp_records_root):
    """delete() should remove to_ref from parent's children_refs."""
    parent, parent_ref = _create_parent_on_disk(tmp_records_root)
    child_ref = _make_child_ref()

    # First add the child to parent via add_child (writes to disk)
    parent.add_child(child_ref)

    # Verify it's there
    reloaded = _reload_parent(Path(parent_ref.path))
    children = reloaded.children_refs
    assert any(c.id == "child-1" for c in children)

    # Now create relationship, set it up on disk, and delete it
    rel = RelationshipRecord.child(parent_ref, child_ref)
    _setup_rel_on_disk(rel, tmp_records_root)

    rel.delete()

    # Reload and verify child is removed
    reloaded = _reload_parent(Path(parent_ref.path))
    children = reloaded.children_refs
    assert not any(c.id == "child-1" for c in children)


def test_save_dedup(tmp_records_root):
    """Saving the same relationship twice should not duplicate in parent's children_refs."""
    parent, parent_ref = _create_parent_on_disk(tmp_records_root)
    child_ref = _make_child_ref()
    rel = RelationshipRecord.child(parent_ref, child_ref)
    _setup_rel_on_disk(rel, tmp_records_root)

    rel.save()
    rel.save()

    reloaded = _reload_parent(Path(parent_ref.path))
    children = reloaded.children_refs
    matching = [c for c in children if c.id == "child-1"]
    assert len(matching) == 1


def test_sync_tolerates_missing_parent(tmp_records_root):
    """_sync_parent_children_refs should not error when parent path doesn't exist."""
    parent_ref = RecordRef(id="nonexistent", type="task", path="/tmp/nonexistent/path")
    child_ref = _make_child_ref()
    rel = RelationshipRecord.child(parent_ref, child_ref)
    _setup_rel_on_disk(rel, tmp_records_root)

    rel.save()


def test_sync_tolerates_non_recordref(tmp_records_root):
    """_sync_parent_children_refs should not error when from_ref is a plain dict."""
    rel = RelationshipRecord(
        id="test-rel",
        type="child",
        from_ref={"id": "p1", "type": "task"},
        to_ref={"id": "c1", "type": "task"},
    )
    _setup_rel_on_disk(rel, tmp_records_root)
    # from_ref gets converted to RecordRef in __init__, but path will be None
    rel.save()
