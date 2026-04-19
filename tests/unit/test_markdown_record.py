"""Unit tests for AssetRecord parent/child hierarchy using the Record fs_store layer.

These tests exercise:
1. Basic parent-child linking: add_child(), parent, children
2. Folder + skill asset: move asset to different parent, verify source_vfs_path unchanged
3. Multi-level nesting: add/move/delete, move a whole branch under a new node
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root
from flow_sdk.fs_store.record_ref import RecordRef
from flow_sdk.fs_records.markdown_record import MarkdownRecord as AssetRecord


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_records_root(tmp_path: Path):
    """Redirect all record saves to a temporary directory."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def make_asset(
    title: str,
    asset_type: str = "doc",
    source_vfs_path: str | None = None,
) -> AssetRecord:
    """Create an AssetRecord and persist it to disk (using default_path)."""
    kwargs: dict = {"title": title, "asset_type": asset_type}
    if source_vfs_path:
        kwargs["source_vfs_path"] = source_vfs_path
    rec = AssetRecord(**kwargs)
    rec.save()
    assert rec.path is not None, "save() must set path (folder)"
    return rec


def reload(rec: AssetRecord) -> AssetRecord:
    """Reload an AssetRecord from disk by its directory path."""
    folder = Path(rec.path)
    return AssetRecord.load_record(folder)


def _folder_ref(rec: AssetRecord) -> RecordRef:
    """Build a RecordRef pointing at the record's folder (not metadata.json).

    Using the folder path ensures init_record() will run the full split-format
    loader (metadata.json + _obj_data.json), so domain fields like title and
    asset_type survive the round-trip.
    """
    return RecordRef(id=rec.id, type=rec.type, path=rec.path)


def link_child(parent: AssetRecord, child: AssetRecord) -> None:
    """Add *child* to *parent* using a folder-path ref and save both."""
    parent.add_child(_folder_ref(child))  # saves parent immediately
    child.parent_ref = _folder_ref(parent)
    child.save()


def get_children_of(parent: AssetRecord) -> list[AssetRecord]:
    """Return all AssetRecord children of *parent* loaded from disk.

    Resolves each child ref to its folder so the full split format is loaded.
    """
    parent_fresh = reload(parent)
    results = []
    for ref in parent_fresh.children_refs:
        if not ref.path:
            continue
        p = Path(ref.path)
        # Ref may point to metadata.json (file) or the record dir – normalise to dir.
        folder = p if p.is_dir() else p.parent
        if folder.exists():
            results.append(AssetRecord.load_record(folder))
    return results


def move_child(child: AssetRecord, old_parent: AssetRecord, new_parent: AssetRecord) -> None:
    """Move *child* from *old_parent* to *new_parent*, updating all refs on disk."""
    # 1. Remove from old parent's children_refs
    old_fresh = reload(old_parent)
    old_fresh.children_refs = [r for r in old_fresh.children_refs if r.id != child.id]
    old_fresh.save()

    # 2. Add to new parent using folder ref
    child_fresh = reload(child)
    new_parent_fresh = reload(new_parent)
    new_parent_fresh.add_child(_folder_ref(child_fresh))  # saves new_parent immediately

    # 3. Update child's parent_ref
    child_fresh.parent_ref = _folder_ref(new_parent_fresh)
    child_fresh.save()


def all_assets_with_parent(parent: AssetRecord, root: Path) -> list[AssetRecord]:
    """Scan all asset records in *root* and return those whose parent_ref.id == parent.id."""
    results = []
    asset_dir = root / "markdown"
    if not asset_dir.exists():
        return results
    for entry in asset_dir.iterdir():
        if not entry.is_dir():
            continue
        try:
            rec = AssetRecord.load_record(entry)
            if rec.parent_ref and rec.parent_ref.id == parent.id:
                results.append(rec)
        except Exception:
            continue
    return results


# ---------------------------------------------------------------------------
# Scenario 1 — Basic parent-child linking
# ---------------------------------------------------------------------------


class TestBasicParentChild:
    def test_add_child_appears_in_children(self, tmp_records_root):
        """link_child(parent, A) → parent.children contains A."""
        parent = make_asset("Parent B", "folder")
        child = make_asset("Child A", "doc")

        link_child(parent, child)

        children = get_children_of(parent)
        child_ids = [c.id for c in children]
        assert child.id in child_ids

    def test_parent_ref_set_after_add(self, tmp_records_root):
        """link_child sets parent_ref on child; child.parent resolves to parent."""
        parent = make_asset("Parent B", "folder")
        child = make_asset("Child A", "doc")

        link_child(parent, child)

        # Reload child and navigate to parent via parent_ref
        child_fresh = reload(child)
        assert child_fresh.parent_ref is not None
        assert child_fresh.parent_ref.id == parent.id

        # .parent property should load parent from disk
        resolved_parent = child_fresh.parent
        assert resolved_parent is not None
        assert resolved_parent.id == parent.id

    def test_child_title_preserved_after_add(self, tmp_records_root):
        """Children loaded from disk retain their domain data (title)."""
        parent = make_asset("Folder", "folder")
        child = make_asset("My Doc", "doc")

        link_child(parent, child)

        children = get_children_of(parent)
        assert any(getattr(c, 'title', None) == "My Doc" for c in children)

    def test_multiple_children(self, tmp_records_root):
        """Parent can have multiple children; all appear in children list."""
        parent = make_asset("Parent", "folder")
        child_a = make_asset("A", "doc")
        child_b = make_asset("B", "skill")
        child_c = make_asset("C", "workflow")

        link_child(parent, child_a)
        link_child(parent, child_b)
        link_child(parent, child_c)

        children = get_children_of(parent)
        ids = {c.id for c in children}
        assert child_a.id in ids
        assert child_b.id in ids
        assert child_c.id in ids

    def test_no_duplicate_on_double_add(self, tmp_records_root):
        """Adding the same child twice does not create a duplicate ref."""
        parent = make_asset("Parent", "folder")
        child = make_asset("Child", "doc")

        link_child(parent, child)
        parent_fresh = reload(parent)
        parent_fresh.add_child(_folder_ref(child))  # second add — should be no-op
        parent_fresh.save()

        parent_reloaded = reload(parent)
        matching = [r for r in parent_reloaded.children_refs if r.id == child.id]
        assert len(matching) == 1

    def test_query_children_by_parent_scan(self, tmp_records_root):
        """Directory scan returns only records whose parent_ref.id matches."""
        folder = make_asset("Folder", "folder")
        doc1 = make_asset("Doc 1", "doc")
        doc2 = make_asset("Doc 2", "doc")
        unrelated = make_asset("Unrelated", "doc")

        link_child(folder, doc1)
        link_child(folder, doc2)
        # unrelated has no parent

        found = all_assets_with_parent(folder, tmp_records_root)
        found_ids = {r.id for r in found}
        assert doc1.id in found_ids
        assert doc2.id in found_ids
        assert unrelated.id not in found_ids


# ---------------------------------------------------------------------------
# Scenario 2 — Folder + skill: move, path stays, pointers update
# ---------------------------------------------------------------------------


class TestFolderSkillMove:
    def test_move_skill_to_different_parent(self, tmp_records_root):
        """Moving a skill from folder A to folder B updates parent/child refs.
        The source_vfs_path (physical file location) must not change."""
        folder_a = make_asset("Folder A", "folder")
        folder_b = make_asset("Folder B", "folder")
        skill = make_asset("My Skill", "skill", source_vfs_path="skills/my-skill/SKILL.md")

        # Link skill under folder_a
        link_child(folder_a, skill)

        original_vfs_path = getattr(skill, 'source_vfs_path', None)

        # Move skill to folder_b
        move_child(skill, folder_a, folder_b)

        # --- Verify source_vfs_path unchanged ---
        skill_fresh = reload(skill)
        assert getattr(skill_fresh, 'source_vfs_path', None) == original_vfs_path, (
            "Physical file path must not change when moving a record"
        )

        # --- Verify old parent no longer lists skill ---
        folder_a_fresh = reload(folder_a)
        old_ids = {r.id for r in folder_a_fresh.children_refs}
        assert skill.id not in old_ids, "Old parent should not list moved child"

        # --- Verify new parent lists skill ---
        folder_b_fresh = reload(folder_b)
        new_ids = {r.id for r in folder_b_fresh.children_refs}
        assert skill.id in new_ids, "New parent must list moved child"

        # --- Verify child's parent_ref points to folder_b ---
        assert skill_fresh.parent_ref is not None
        assert skill_fresh.parent_ref.id == folder_b.id, (
            "Child's parent_ref must point to new parent"
        )

    def test_scan_query_reflects_new_parent(self, tmp_records_root):
        """After move, directory scan returns skill under new parent only."""
        folder_a = make_asset("Folder A", "folder")
        folder_b = make_asset("Folder B", "folder")
        skill = make_asset("Skill", "skill", source_vfs_path="skills/s/SKILL.md")

        link_child(folder_a, skill)

        move_child(skill, folder_a, folder_b)

        under_a = all_assets_with_parent(folder_a, tmp_records_root)
        under_b = all_assets_with_parent(folder_b, tmp_records_root)

        assert not any(r.id == skill.id for r in under_a)
        assert any(r.id == skill.id for r in under_b)

    def test_move_to_root_clears_parent_ref(self, tmp_records_root):
        """Moving a child to 'root' (no parent) clears its parent_ref."""
        folder = make_asset("Folder", "folder")
        doc = make_asset("Doc", "doc")

        link_child(folder, doc)

        # Remove from folder's children
        folder_fresh = reload(folder)
        folder_fresh.children_refs = [r for r in folder_fresh.children_refs if r.id != doc.id]
        folder_fresh.save()

        # Clear child's parent_ref
        doc_fresh = reload(doc)
        doc_fresh.parent_ref = None
        doc_fresh.save()

        # Verify
        doc_reloaded = reload(doc_fresh)
        assert doc_reloaded.parent_ref is None
        folder_reloaded = reload(folder)
        assert not any(r.id == doc.id for r in folder_reloaded.children_refs)


# ---------------------------------------------------------------------------
# Scenario 3 — Multi-level nesting, add/move/delete, move whole branch
# ---------------------------------------------------------------------------


class TestMultiLevelNesting:
    def _build_tree(self) -> tuple[AssetRecord, ...]:
        """
        Build this tree and return all nodes:

            root (folder)
            ├── branch_a (folder)
            │   ├── leaf_a1 (doc)
            │   └── leaf_a2 (skill)
            └── branch_b (folder)
                └── leaf_b1 (doc)
        """
        root = make_asset("Root", "folder")

        branch_a = make_asset("Branch A", "folder")
        link_child(root, branch_a)

        branch_b = make_asset("Branch B", "folder")
        link_child(root, branch_b)

        leaf_a1 = make_asset("Leaf A1", "doc")
        link_child(branch_a, leaf_a1)

        leaf_a2 = make_asset("Leaf A2", "skill")
        link_child(branch_a, leaf_a2)

        leaf_b1 = make_asset("Leaf B1", "doc")
        link_child(branch_b, leaf_b1)

        return root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1

    def test_three_level_depth(self, tmp_records_root):
        """Children are accessible at three levels of depth."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        root_children = get_children_of(root)
        root_ids = {c.id for c in root_children}
        assert branch_a.id in root_ids
        assert branch_b.id in root_ids

        branch_a_children = get_children_of(branch_a)
        a_ids = {c.id for c in branch_a_children}
        assert leaf_a1.id in a_ids
        assert leaf_a2.id in a_ids

        branch_b_children = get_children_of(branch_b)
        b_ids = {c.id for c in branch_b_children}
        assert leaf_b1.id in b_ids

    def test_move_leaf_between_branches(self, tmp_records_root):
        """Moving leaf_a1 from branch_a to branch_b updates all refs."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        move_child(leaf_a1, branch_a, branch_b)

        # branch_a should no longer list leaf_a1
        a_fresh = reload(branch_a)
        assert not any(r.id == leaf_a1.id for r in a_fresh.children_refs)

        # branch_b should now list leaf_a1
        b_fresh = reload(branch_b)
        b_ids = {r.id for r in b_fresh.children_refs}
        assert leaf_a1.id in b_ids

        # leaf_a1 parent_ref points to branch_b
        leaf_a1_fresh = reload(leaf_a1)
        assert leaf_a1_fresh.parent_ref is not None
        assert leaf_a1_fresh.parent_ref.id == branch_b.id

        # leaf_a2 still in branch_a
        a_ids = {r.id for r in a_fresh.children_refs}
        assert leaf_a2.id in a_ids

    def test_delete_leaf(self, tmp_records_root):
        """Deleting a leaf removes it from parent's children_refs."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        # Remove leaf_a1 from branch_a's children_refs
        branch_a_fresh = reload(branch_a)
        branch_a_fresh.children_refs = [
            r for r in branch_a_fresh.children_refs if r.id != leaf_a1.id
        ]
        branch_a_fresh.save()

        # Verify
        updated = reload(branch_a)
        ids = {r.id for r in updated.children_refs}
        assert leaf_a1.id not in ids
        assert leaf_a2.id in ids  # sibling untouched

    def test_move_whole_branch_under_new_node(self, tmp_records_root):
        """Move branch_a (with its children) under branch_b.
        All of branch_a's children remain reachable via branch_a."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        # Move branch_a under branch_b
        move_child(branch_a, root, branch_b)

        # root no longer has branch_a
        root_fresh = reload(root)
        root_ids = {r.id for r in root_fresh.children_refs}
        assert branch_a.id not in root_ids
        assert branch_b.id in root_ids  # branch_b still there

        # branch_b now has branch_a as child
        b_fresh = reload(branch_b)
        b_ids = {r.id for r in b_fresh.children_refs}
        assert branch_a.id in b_ids

        # branch_a's children (leaf_a1, leaf_a2) are untouched
        a_fresh = reload(branch_a)
        a_ids = {r.id for r in a_fresh.children_refs}
        assert leaf_a1.id in a_ids
        assert leaf_a2.id in a_ids

        # branch_a's parent_ref now points to branch_b
        assert a_fresh.parent_ref is not None
        assert a_fresh.parent_ref.id == branch_b.id

        # Deep path: branch_b → branch_a → leaf_a1 via children property
        branch_a_via_children = next(
            (AssetRecord.load_record(Path(r.path)) for r in b_fresh.children_refs if r.id == branch_a.id and r.path),
            None,
        )
        assert branch_a_via_children is not None
        a2_ids = {r.id for r in branch_a_via_children.children_refs}
        assert leaf_a1.id in a2_ids

    def test_scan_query_reflects_all_levels(self, tmp_records_root):
        """After building tree, directory scan returns correct parent for each node."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        under_root = all_assets_with_parent(root, tmp_records_root)
        under_a = all_assets_with_parent(branch_a, tmp_records_root)
        under_b = all_assets_with_parent(branch_b, tmp_records_root)

        assert {r.id for r in under_root} == {branch_a.id, branch_b.id}
        assert {r.id for r in under_a} == {leaf_a1.id, leaf_a2.id}
        assert {r.id for r in under_b} == {leaf_b1.id}

    def test_add_new_node_mid_tree(self, tmp_records_root):
        """Insert a new node between root and branch_a."""
        root, branch_a, branch_b, leaf_a1, leaf_a2, leaf_b1 = self._build_tree()

        # Create new intermediate folder
        mid = make_asset("Mid", "folder")

        # Attach mid under root
        link_child(root, mid)

        # Move branch_a under mid
        move_child(branch_a, root, mid)

        # Verify root → mid → branch_a chain
        root_fresh = reload(root)
        root_ids = {r.id for r in root_fresh.children_refs}
        assert mid.id in root_ids
        assert branch_a.id not in root_ids

        mid_fresh = reload(mid)
        mid_ids = {r.id for r in mid_fresh.children_refs}
        assert branch_a.id in mid_ids

        a_fresh = reload(branch_a)
        assert a_fresh.parent_ref is not None
        assert a_fresh.parent_ref.id == mid.id

    def test_get_children_by_type(self, tmp_records_root):
        """get_children_by_type() filters children by type string."""
        parent = make_asset("Parent", "folder")
        doc = make_asset("Doc", "doc")
        skill = make_asset("Skill", "skill")
        workflow = make_asset("Workflow", "workflow")

        link_child(parent, doc)
        link_child(parent, skill)
        link_child(parent, workflow)

        # get_children_of uses folder refs so domain data (_obj_data.json) is fully loaded
        all_children = get_children_of(parent)
        assert len(all_children) == 3

        # Filter by asset_type in data (manual)
        skills = [c for c in all_children if getattr(c, 'asset_type', None) == "skill"]
        docs = [c for c in all_children if getattr(c, 'asset_type', None) == "doc"]
        assert len(skills) == 1
        assert skills[0].id == skill.id
        assert len(docs) == 1
        assert docs[0].id == doc.id
