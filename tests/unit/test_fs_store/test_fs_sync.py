"""Tests for Record fs_sync -- auto-persist on attribute/item changes."""

import json

from flow_sdk.fs_store import Record


class TestFsSyncDefault:
    def test_fs_sync_defaults_to_false(self):
        r = Record(id="x")
        assert r.fs_sync is False

    def test_fs_sync_false_does_not_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.name = "changed"
        assert not fp.exists()

    def test_fs_sync_excluded_from_to_dict(self):
        r = Record(id="x", fs_sync=True)
        d = r.meta_dict()
        assert "fs_sync" not in d

    def test_fs_sync_excluded_from_json_output(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record(id="x")
        r.save_record_json(fp)
        r.fs_sync = True
        r.name = "trigger"
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert "fs_sync" not in data


class TestFsSyncAutoSave:
    def test_setattr_triggers_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.save_record_json(fp)
        r.fs_sync = True
        r.name = "auto-saved"
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["name"] == "auto-saved"

    def test_setitem_raw_json_triggers_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.save_record_json(fp)
        r.fs_sync = True
        r["custom_key"] = "custom_val"
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["custom_key"] == "custom_val"

    def test_no_persist_without_source_file(self, tmp_path):
        r = Record(id="no-file")
        r.fs_sync = True
        r.source_file = None
        # Should not raise -- just skip persist
        r.name = "changed"

    def test_source_file_change_does_not_trigger_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record(id="x")
        r.save_record_json(fp)
        r.fs_sync = True
        # Changing source_file itself should not re-persist
        r.source_file = str(tmp_path / "other.json")
        assert not (tmp_path / "other.json").exists()

    def test_path_change_does_not_trigger_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.save_record_json(fp)
        original = fp.read_text()
        r.fs_sync = True
        r.path = "/some/other/path"
        assert fp.read_text() == original

    def test_private_attrs_do_not_trigger_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.save_record_json(fp)
        original = fp.read_text()
        r.fs_sync = True
        r._custom_private = "ignored"
        assert fp.read_text() == original

    def test_multiple_changes_persist_each(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r.save_record_json(fp)
        r.fs_sync = True
        r.name = "first"
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["name"] == "first"
        r.name = "second"
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["name"] == "second"
