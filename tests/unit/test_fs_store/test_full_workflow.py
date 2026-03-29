"""Integration tests — end-to-end workflows across all phases."""

import json

import pytest

from flow_sdk.fs_store import Record, ReadOnlyRecordError
from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def _isolate_default_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "flow_records")
    yield
    set_default_records_root(original)


class TestFullWorkflow:
    def test_task_lifecycle(self, tmp_path):
        """Create TaskResource → save to default → load polymorphically →
        clone → verify origin_ref → move the clone → verify old cleaned up."""
        from flow_sdk.fs_records import TaskResource

        # 1. Create and save to default path
        task = TaskResource(id="lifecycle-1", title="Integration Test", status="To Do")
        task.save()

        # 2. Load polymorphically via Record.load
        default_dir = tmp_path / "flow_records" / "task" / "task-@lifecycle-1"
        loaded = Record.load(default_dir)
        assert isinstance(loaded, TaskResource)
        assert loaded.title == "Integration Test"

        # 3. Clone to new location
        clone_dir = tmp_path / "clones" / "task-clone"
        clone = loaded.clone(clone_dir)
        assert clone.id != "lifecycle-1"
        assert clone.title == "Integration Test"
        assert clone.origin_ref is not None
        assert clone.origin_ref.id == "lifecycle-1"

        # 4. Move the clone
        moved_dir = tmp_path / "moved" / "task-moved"
        clone.move(moved_dir)
        assert not clone_dir.exists()
        assert (moved_dir / "metadata.json").exists()

        # 5. Original still intact
        reloaded = Record.load(default_dir)
        assert reloaded.id == "lifecycle-1"

    def test_skill_yaml_bootstrap(self, tmp_path):
        """Create SkillRecord from SKILL.md → metadata.json goes to records_root shadow,
        NOT the skill source dir. Reload from skill_dir re-bootstraps from YAML."""
        from flow_sdk.fs_records.skill_record import SkillRecord

        skill_dir = tmp_path / "skills" / "skill-@my-skill"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: my-skill\ndescription: A test skill\ntags: test\n---\n# My Skill"
        )

        rec = SkillRecord.load_record(skill_dir)
        assert rec.name == "my-skill"
        assert rec.description == "A test skill"

        # metadata.json must NOT be written to the skill source dir
        assert not (skill_dir / "metadata.json").exists(), \
            "metadata.json must not be written to the skill source dir"

        # To persist to disk, call save() — it goes to records_root shadow
        rec.save()
        shadow_dir = get_default_records_root() / "skill" / "skill-@my-skill"
        assert (shadow_dir / "metadata.json").exists()

        # Reload from skill_dir still works (re-bootstraps from YAML)
        reloaded = SkillRecord.load_record(skill_dir)
        assert reloaded.name == "my-skill"

    def test_claude_session_read_only(self):
        """Attempting to save a ClaudeSessionFsRecord raises ReadOnlyRecordError."""
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord

        session = ClaudeSessionFsRecord(id="sess-1", session_id="sess-1")
        with pytest.raises(ReadOnlyRecordError):
            session.save()

    def test_record_list_default_fallback(self, tmp_path):
        """ResourceRecordList with no records_path uses default root."""
        from flow_sdk.fs_store import ResourceRecordList
        from flow_sdk.fs_records import TaskResource

        rl = ResourceRecordList(
            record_class=TaskResource,
        )
        assert rl.list_path == tmp_path / "flow_records" / "task"

    @pytest.mark.asyncio
    async def test_delete_cleans_up(self, tmp_path):
        """Create a record, delete it, verify it's gone."""
        folder = tmp_path / "entity"
        rec = Record._init_record({"id": "del1", "type": "test"}, folder)
        assert folder.exists()

        await rec.delete()
        assert not folder.exists()
        assert rec.source_file is None
