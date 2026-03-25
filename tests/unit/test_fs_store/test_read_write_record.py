"""Tests for read_record / write_record protocol and read-only flag."""

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store import Record, ReadOnlyRecordError


class TestReadRecord:
    def test_read_record_populates_fields(self, tmp_path):
        fp = tmp_path / "rec.json"
        fp.write_text(json.dumps({"id": "r1", "type": "test", "name": "hello"}))

        rec = Record()
        rec.read_record(fp)
        assert rec.id == "r1"
        assert rec.name == "hello"

    def test_write_record_creates_json(self, tmp_path):
        fp = tmp_path / "out.json"
        rec = Record(id="w1", type="test", name="written")
        rec.write_record(fp)
        assert fp.exists()
        data = json.loads(fp.read_text())
        assert data["id"] == "w1"
        assert data["name"] == "written"


class TestReadOnly:
    def test_read_only_write_raises(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
        rec = ClaudeSessionFsRecord(id="s1")
        with pytest.raises(ReadOnlyRecordError):
            rec.write_record(tmp_path / "out.json")

    def test_read_only_save_raises(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
        rec = ClaudeSessionFsRecord(id="s1")
        rec.source_file = str(tmp_path / "out.json")
        with pytest.raises(ReadOnlyRecordError):
            rec.save()

    def test_read_only_save_record_json_raises(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
        rec = ClaudeSessionFsRecord(id="s1")
        with pytest.raises(ReadOnlyRecordError):
            rec.save_record_json(tmp_path / "out.json")

    def test_regular_record_not_read_only(self, tmp_path):
        fp = tmp_path / "out.json"
        rec = Record(id="w1", type="test")
        rec.write_record(fp)
        assert fp.exists()


class TestSkillReadRecord:
    def test_skill_read_record_yaml_bootstrap(self, tmp_path):
        """SkillRecord.read_record bootstraps from YAML when JSON doesn't exist."""
        from flow_sdk.fs_records.skill_record import SkillRecord

        folder = tmp_path / "my-skill"
        folder.mkdir()
        (folder / "SKILL.md").write_text("---\nname: cool-skill\ndescription: A cool skill\n---\n# Skill")

        rec = SkillRecord()
        # read_record with non-existent data.json path triggers YAML bootstrap
        rec.read_record(folder / "data.json")
        assert rec.name == "cool-skill"
        assert rec.description == "A cool skill"

    def test_skill_read_record_existing_json(self, tmp_path):
        """SkillRecord.read_record reads JSON when it exists."""
        from flow_sdk.fs_records.skill_record import SkillRecord

        folder = tmp_path / "my-skill"
        folder.mkdir(parents=True)
        (folder / "data.json").write_text(
            json.dumps({"data": {"id": "s1", "type": "skill", "name": "from-json"}})
        )

        rec = SkillRecord()
        rec.read_record(folder / "data.json")
        assert rec.name == "from-json"


class TestClaudeSessionReadRecord:
    def test_claude_session_read_record_from_jsonl(self, tmp_path):
        """ClaudeSessionFsRecord.read_record parses JSONL files."""
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord

        jsonl = tmp_path / "session.jsonl"
        entries = [
            {"type": "user", "sessionId": "sess-1", "cwd": "/tmp", "version": "1.0",
             "gitBranch": "main", "slug": "test-session", "uuid": "u1", "timestamp": "2025-01-01"},
            {"type": "assistant", "uuid": "u2", "timestamp": "2025-01-01",
             "message": {"model": "claude-3", "content": [{"type": "text", "text": "hi"}],
                         "usage": {"input_tokens": 10, "output_tokens": 20}}},
        ]
        jsonl.write_text("\n".join(json.dumps(e) for e in entries))

        rec = ClaudeSessionFsRecord()
        rec.read_record(jsonl)
        assert rec.session_id == "sess-1"
        assert rec.user_message_count == 1
        assert rec.assistant_message_count == 1
        assert rec.input_tokens == 10
        assert rec.output_tokens == 20
