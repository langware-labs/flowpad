"""FSRef unit tests — direct Python FSRef implementation.

DoF matrix: Ref type (dir, file-direct, file-nested) x State (new, partial, full) x Op (exists, read, write, children, delete)
Direct disk validation via Path on every mutating op.
"""

import pytest

from flow_sdk.fs_store.fs_ref import FrontMatterFsRef, FSRef, JSONFsRef, TextFsRef


@pytest.fixture
def base_dir(tmp_path):
    return tmp_path / "test-skill"


@pytest.fixture
def asset_ref(base_dir):
    return FSRef(base_dir)


@pytest.fixture
def skill_md_ref(asset_ref):
    return asset_ref.child("SKILL.md")


@pytest.fixture
def nested_ref(asset_ref):
    return asset_ref.child("data/notes.md")


# ---------------------------------------------------------------------------
# Dir ref
# ---------------------------------------------------------------------------

class TestDirRef:
    def test_exists_new_state(self, asset_ref):
        assert not asset_ref.exists()

    def test_exists_after_mkdir(self, asset_ref):
        asset_ref.mkdir()
        assert asset_ref.exists()

    def test_children_new_state_returns_empty(self, asset_ref):
        # dir missing → children() returns []
        assert asset_ref.children() == []

    def test_children_after_write(self, asset_ref, skill_md_ref):
        skill_md_ref.write("# content")
        names = [r.name for r in asset_ref.children()]
        assert "SKILL.md" in names

    def test_delete_new_state_is_noop(self, asset_ref):
        asset_ref.delete()  # nothing to delete — must not raise
        assert not asset_ref.exists()


# ---------------------------------------------------------------------------
# File ref — new state  (dir missing, file missing)
# ---------------------------------------------------------------------------

class TestFileRefNewState:
    def test_exists_false(self, skill_md_ref):
        assert not skill_md_ref.exists()

    def test_read_raises(self, skill_md_ref):
        with pytest.raises((FileNotFoundError, OSError)):
            skill_md_ref.read()

    def test_write_creates_dir_and_file(self, skill_md_ref, base_dir):
        skill_md_ref.write("# hello")
        assert (base_dir / "SKILL.md").exists()
        assert (base_dir / "SKILL.md").read_text(encoding="utf-8") == "# hello"

    def test_delete_is_noop(self, skill_md_ref):
        skill_md_ref.delete()  # file absent — must not raise
        assert not skill_md_ref.exists()


# ---------------------------------------------------------------------------
# File ref — partial state  (dir exists, file missing)
# ---------------------------------------------------------------------------

class TestFileRefPartialState:
    @pytest.fixture(autouse=True)
    def make_dir(self, base_dir):
        base_dir.mkdir(parents=True, exist_ok=True)

    def test_exists_false(self, skill_md_ref):
        assert not skill_md_ref.exists()

    def test_read_raises(self, skill_md_ref):
        with pytest.raises((FileNotFoundError, OSError)):
            skill_md_ref.read()

    def test_write_creates_file_in_existing_dir(self, skill_md_ref, base_dir):
        skill_md_ref.write("# partial")
        assert (base_dir / "SKILL.md").read_text(encoding="utf-8") == "# partial"

    def test_delete_is_noop(self, skill_md_ref):
        skill_md_ref.delete()  # file absent — must not raise
        assert not skill_md_ref.exists()


# ---------------------------------------------------------------------------
# File ref — full state  (dir exists, file exists)
# ---------------------------------------------------------------------------

class TestFileRefFullState:
    @pytest.fixture(autouse=True)
    def make_file(self, skill_md_ref):
        skill_md_ref.write("# original")

    def test_exists_true(self, skill_md_ref):
        assert skill_md_ref.exists()

    def test_read_returns_content(self, skill_md_ref):
        assert skill_md_ref.read() == "# original"

    def test_write_overwrites(self, skill_md_ref, base_dir):
        skill_md_ref.write("# updated")
        assert (base_dir / "SKILL.md").read_text(encoding="utf-8") == "# updated"

    def test_delete_removes_file(self, skill_md_ref, base_dir):
        skill_md_ref.delete()
        assert not (base_dir / "SKILL.md").exists()
        assert not skill_md_ref.exists()


# ---------------------------------------------------------------------------
# Read-only enforcement
# ---------------------------------------------------------------------------

class TestReadOnly:
    def test_direct_read_only_ref_raises_on_write(self, base_dir):
        ref = FSRef(base_dir / "SKILL.md", read_only=True)
        with pytest.raises(IOError):
            ref.write("# content")

    def test_read_only_parent_propagates_to_child(self, base_dir):
        ro_parent = FSRef(base_dir, read_only=True)
        child = ro_parent.child("SKILL.md")
        with pytest.raises(IOError):
            child.write("# content")


# ---------------------------------------------------------------------------
# Nested file ref
# ---------------------------------------------------------------------------

class TestNestedFileRef:
    def test_write_creates_intermediate_dirs(self, nested_ref, base_dir):
        nested_ref.write("nested")
        assert (base_dir / "data" / "notes.md").exists()
        assert (base_dir / "data" / "notes.md").read_text(encoding="utf-8") == "nested"
        assert (base_dir / "data").is_dir()

    def test_delete_leaves_parent_dir_intact(self, nested_ref, base_dir):
        nested_ref.write("content")
        nested_ref.delete()
        assert not (base_dir / "data" / "notes.md").exists()
        assert (base_dir / "data").is_dir()  # parent dir survives


# ---------------------------------------------------------------------------
# to_dict / from_dict
# ---------------------------------------------------------------------------

class TestToDict:
    def test_base_fsref_file_includes_required_keys(self, skill_md_ref):
        d = skill_md_ref.to_dict(type_id="compute_node-@local")
        assert d["path"] == skill_md_ref.path
        assert d["ref_type"] == "file"
        assert d["read_only"] is False
        assert d["type_id"] == "compute_node-@local"

    def test_base_fsref_dir_has_folder_type(self, asset_ref, base_dir):
        base_dir.mkdir(parents=True, exist_ok=True)
        d = asset_ref.to_dict()
        assert d["ref_type"] == "folder"

    def test_json_fsref_has_json_type(self, base_dir):
        ref = JSONFsRef(base_dir / "_obj_data.json")
        d = ref.to_dict(type_id="skill-abc123")
        assert d["ref_type"] == "json"
        assert d["type_id"] == "skill-abc123"

    def test_text_fsref_has_text_type(self, base_dir):
        ref = TextFsRef(base_dir / "SKILL.md")
        d = ref.to_dict()
        assert d["ref_type"] == "text"

    def test_read_only_flag_in_dict(self, base_dir):
        ref = FSRef(base_dir / "SKILL.md", read_only=True)
        d = ref.to_dict()
        assert d["read_only"] is True

    def test_from_dict_roundtrip_json_fsref(self, base_dir):
        original = JSONFsRef(base_dir / "data.json")
        d = original.to_dict(type_id="x-y")
        restored = FSRef.from_dict(d)
        assert isinstance(restored, JSONFsRef)
        assert restored.path == original.path

    def test_from_dict_roundtrip_text_fsref(self, base_dir):
        original = TextFsRef(base_dir / "README.md")
        d = original.to_dict()
        restored = FSRef.from_dict(d)
        assert isinstance(restored, TextFsRef)
        assert restored.path == original.path

    def test_from_dict_plain_file(self, base_dir):
        original = FSRef(base_dir / "some.txt")
        d = original.to_dict()
        restored = FSRef.from_dict(d)
        assert type(restored) is FSRef
        assert restored.path == original.path


# ---------------------------------------------------------------------------
# main_ref
# ---------------------------------------------------------------------------

class TestMainRef:
    def test_base_record_main_ref_no_path_returns_none(self):
        # Record class slated for deletion; FSRecord.main_ref is asset_ref.
        import pytest
        pytest.skip("Record.main_ref tests pending FSRecord rewrite")

    def test_base_record_main_ref_with_path_returns_json_fsref(self, tmp_path):
        import pytest
        pytest.skip("Record.main_ref tests pending FSRecord rewrite")

    def test_skill_record_main_ref_returns_frontmatter_fsref(self, tmp_path):
        # SkillRecord subclass deleted — main_ref FrontMatterFsRef dispatch
        # was per-subclass behavior. Skip until per-type main_ref hook lands.
        import pytest
        pytest.skip("Skill main_ref dispatch moves to entity in a later phase")

    def test_agent_record_main_ref_returns_frontmatter_fsref(self, tmp_path):
        from flow_sdk.fs_store.operations.subagent import extract_subagent_from_path
        folder = tmp_path / "agent-@myagent"
        folder.mkdir()
        md = folder / "myagent.md"
        md.write_text("---\nname: myagent\n---\nHello\n")
        rec = extract_subagent_from_path(md)
        rec.path = str(folder)
        mr = rec.main_ref
        assert mr is not None
        assert isinstance(mr, FrontMatterFsRef)
        assert "myagent.md" in mr.path
