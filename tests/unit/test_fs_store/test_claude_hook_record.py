"""Tests for ClaudeHookRecord — individual hook commands as fs_records."""

import json
from unittest import mock

import pytest

from flow_sdk.fs_store import RecordType
from flow_sdk.fs_records.claude.claude_hook_record import (
    ClaudeHookRecord,
    ClaudeHookRecordList,
    _parse_hooks_from_file,
    _parse_hooks_from_plugins,
)


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

SAMPLE_HOOKS_SETTINGS = {
    "model": "claude-sonnet-4-6",
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {"type": "command", "command": "echo pre-bash"},
                    {"type": "command", "command": "echo second"},
                ],
            },
            {
                "matcher": "Edit",
                "hooks": [
                    {"type": "command", "command": "echo pre-edit"},
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {"type": "command", "command": "echo post-all"},
                ],
            },
        ],
    },
}

SAMPLE_HOOKS_WITH_FLOW_METADATA = {
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": "echo managed-hook",
                        "flow_metadata": {
                            "name": "My Managed Hook",
                            "flowpad_hook_id": "hook-abc-123",
                        },
                    },
                ],
            },
        ],
    },
}


# ---------------------------------------------------------------------------
# TestParseHooksFromFile
# ---------------------------------------------------------------------------


class TestParseHooksFromFile:
    def test_basic_extraction(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")

        # 2 + 1 + 1 = 4 hooks total
        assert len(records) == 4

    def test_fields_populated(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")
        first = records[0]

        assert first.event_type == "PreToolUse"
        assert first.matcher == "Bash"
        assert first.command == "echo pre-bash"
        assert first.hook_type == "command"
        assert first.type == RecordType.CLAUDE_HOOK
        scope_val = first.scope.value if hasattr(first.scope, "value") else str(first.scope)
        assert scope_val == "user"
        assert first.source_file == str(f)

    def test_name_from_event_and_matcher(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")
        first = records[0]
        assert first.name == "PreToolUse (Bash)"

    def test_json_path_set(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")

        assert records[0].json_path == "/hooks/PreToolUse/0/hooks/0"
        assert records[1].json_path == "/hooks/PreToolUse/0/hooks/1"
        assert records[2].json_path == "/hooks/PreToolUse/1/hooks/0"
        assert records[3].json_path == "/hooks/PostToolUse/0/hooks/0"

    def test_stable_hash_fields(self, tmp_path):
        """Stable ID is derived from file path + event + matcher:command (no data_ref object)."""
        from flow_sdk.fs_records.claude.claude_hook_record import _stable_hook_hash
        from flow_sdk.fs_store.source_file_record_list import _escape_json_pointer

        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")
        first = records[0]

        # ID must match what _stable_hook_hash produces
        escaped = _escape_json_pointer("PreToolUse")
        expected = _stable_hook_hash(str(f), escaped, "Bash", "echo pre-bash")
        assert first.id == expected
        assert len(first.id) == 36  # uuid5

    def test_parent_ref_set(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")
        first = records[0]

        assert first.parent_ref is not None
        assert first.parent_ref.path == str(f)

    def test_id_is_content_hash(self, tmp_path):
        """Record ID is deterministic from file+event+matcher:command."""
        from flow_sdk.fs_records.claude.claude_hook_record import _stable_hook_hash
        from flow_sdk.fs_store.source_file_record_list import _escape_json_pointer

        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = _parse_hooks_from_file(f, "user")
        first = records[0]

        escaped = _escape_json_pointer("PreToolUse")
        expected = _stable_hook_hash(str(f), escaped, "Bash", "echo pre-bash")
        assert first.id == expected
        assert len(first.id) == 36  # uuid5

    def test_id_deterministic(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records1 = _parse_hooks_from_file(f, "user")
        records2 = _parse_hooks_from_file(f, "user")

        assert records1[0].id == records2[0].id
        assert records1[0].id != ""

    def test_same_location_same_id_regardless_of_scope(self, tmp_path):
        """Same physical hook location = same content_hash ID, regardless of scope label."""
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        user_records = _parse_hooks_from_file(f, "user")
        project_records = _parse_hooks_from_file(f, "project")

        # Same file, same event+matcher+command → same content_hash
        assert user_records[0].id == project_records[0].id

    def test_id_stable_after_deletion(self, tmp_path):
        """Deleting a hook should not change IDs of remaining hooks."""
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records_before = _parse_hooks_from_file(f, "user")
        second_id = records_before[1].id  # "echo second"
        third_id = records_before[2].id   # PreToolUse (Edit)

        # Delete the first hook
        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        first = list(rl)[0]
        rl.delete_record(first.id)

        records_after = _parse_hooks_from_file(f, "user")
        after_ids = {r.id for r in records_after}

        # IDs of surviving hooks are unchanged
        assert second_id in after_ids
        assert third_id in after_ids

    def test_missing_file(self, tmp_path):
        f = tmp_path / "nonexistent.json"
        records = _parse_hooks_from_file(f, "user")
        assert records == []

    def test_invalid_json(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text("not valid json")
        records = _parse_hooks_from_file(f, "user")
        assert records == []

    def test_no_hooks_key(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"model": "test"}))
        records = _parse_hooks_from_file(f, "user")
        assert records == []

    def test_empty_hooks(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"hooks": {}}))
        records = _parse_hooks_from_file(f, "user")
        assert records == []

    def test_different_files_different_ids(self, tmp_path):
        """Same hook content in different files → different content_hash IDs."""
        f1 = tmp_path / "dir1" / "settings.json"
        f2 = tmp_path / "dir2" / "settings.json"
        f1.parent.mkdir()
        f2.parent.mkdir()

        hook_data = json.dumps({
            "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo same"}]}]},
        })
        f1.write_text(hook_data)
        f2.write_text(hook_data)

        records1 = _parse_hooks_from_file(f1, "user")
        records2 = _parse_hooks_from_file(f2, "user")

        # Different file paths → different content_hash
        assert records1[0].id != records2[0].id


# ---------------------------------------------------------------------------
# TestFlowMetadata
# ---------------------------------------------------------------------------


class TestFlowMetadata:
    def test_flow_metadata_fields_extracted(self, tmp_path):
        """flow_metadata from hook body is extracted to management fields in _data."""
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

        records = _parse_hooks_from_file(f, "user")
        assert len(records) == 1

        rec = records[0]
        assert rec.flowpad_hook_id == "hook-abc-123"
        assert rec.flow_metadata_name == "My Managed Hook"
        assert hasattr(rec, "flowpad_hook_id")
        assert hasattr(rec, "flow_metadata_name")

    def test_name_from_flow_metadata(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

        records = _parse_hooks_from_file(f, "user")
        assert records[0].name == "My Managed Hook"

    def test_id_is_content_hash(self, tmp_path):
        """Even managed hooks use stable hash IDs."""
        from flow_sdk.fs_records.claude.claude_hook_record import _stable_hook_hash
        from flow_sdk.fs_store.source_file_record_list import _escape_json_pointer

        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

        records = _parse_hooks_from_file(f, "user")
        rec = records[0]
        escaped = _escape_json_pointer("PreToolUse")
        expected = _stable_hook_hash(str(f), escaped, "Bash", "echo managed-hook")
        assert rec.id == expected
        assert len(rec.id) == 36  # uuid5

    def test_management_fields_in_data(self, tmp_path):
        """Management fields are stored in _data (single dict model)."""
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

        records = _parse_hooks_from_file(f, "user")
        rec = records[0]

        assert hasattr(rec, "flowpad_hook_id")
        assert hasattr(rec, "flow_metadata_name")
        assert getattr(rec, "flow_metadata", None) is None


# ---------------------------------------------------------------------------
# TestDiscover
# ---------------------------------------------------------------------------


class TestDiscover:
    def test_discover_from_temp_dir(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = ClaudeHookRecord.discover(search_paths=[tmp_path])
        assert len(records) == 4

    def test_discover_fields_correct(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        records = ClaudeHookRecord.discover(search_paths=[tmp_path])
        first = records[0]

        assert first.event_type == "PreToolUse"
        assert first.matcher == "Bash"
        assert first.command == "echo pre-bash"
        assert first.type == RecordType.CLAUDE_HOOK


class TestDiscoverMultiFile:
    def test_two_files(self, tmp_path):
        user_dir = tmp_path / "user"
        user_dir.mkdir()
        (user_dir / "settings.json").write_text(json.dumps({
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo user"}]}],
            },
        }))

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        (project_dir / "settings.json").write_text(json.dumps({
            "hooks": {
                "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo project"}]}],
            },
        }))

        records = ClaudeHookRecord.discover(search_paths=[user_dir, project_dir])
        assert len(records) == 2
        event_types = {r.event_type for r in records}
        assert event_types == {"PreToolUse", "PostToolUse"}

    def test_local_settings_file(self, tmp_path):
        (tmp_path / "settings.json").write_text(json.dumps({
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo main"}]}],
            },
        }))
        (tmp_path / "settings.local.json").write_text(json.dumps({
            "hooks": {
                "Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo local"}]}],
            },
        }))

        records = ClaudeHookRecord.discover(search_paths=[tmp_path])
        assert len(records) == 2
        event_types = {r.event_type for r in records}
        assert event_types == {"PreToolUse", "Stop"}


class TestDiscoverOne:
    def test_find_by_uid(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        all_records = ClaudeHookRecord.discover(search_paths=[tmp_path])
        target_uid = all_records[2].id  # PreToolUse (Edit)

        found = ClaudeHookRecord.get(target_uid, search_paths=[tmp_path])
        assert found is not None
        assert found.id == target_uid
        assert found.event_type == "PreToolUse"
        assert found.matcher == "Edit"

    def test_not_found(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        found = ClaudeHookRecord.get("nonexistent-id", search_paths=[tmp_path])
        assert found is None


# ---------------------------------------------------------------------------
# TestRecordList
# ---------------------------------------------------------------------------


class TestRecordList:
    def test_iteration(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        records = list(rl)
        assert len(records) == 4

    def test_len(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(rl) == 4

    def test_get(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        first = list(rl)[0]
        found = rl.get(first.id)
        assert found is not None
        assert found.id == first.id

    def test_records_property(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(rl.records) == 4

    def test_reload(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(rl) == 4

        # Modify file
        f.write_text(json.dumps({
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo only"}]}],
            },
        }))
        rl.reload()
        assert len(rl) == 1


# ---------------------------------------------------------------------------
# TestPersist (write-back)
# ---------------------------------------------------------------------------


class TestPersist:
    def test_update_command(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        first = list(rl)[0]

        rl.update(first.id, {"command": "echo updated"})

        raw = json.loads(f.read_text())
        assert raw["hooks"]["PreToolUse"][0]["hooks"][0]["command"] == "echo updated"
        # Other hooks should be intact
        assert raw["hooks"]["PreToolUse"][0]["hooks"][1]["command"] == "echo second"

    def test_update_preserves_other_settings(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        first = list(rl)[0]
        rl.update(first.id, {"command": "echo new"})

        raw = json.loads(f.read_text())
        assert raw["model"] == "claude-sonnet-4-6"

    def test_update_strips_flow_metadata(self, tmp_path):
        """After update, flow_metadata should NOT be written to settings.json."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            rl = ClaudeHookRecordList(search_paths=[tmp_path])
            first = list(rl)[0]
            rl.update(first.id, {"command": "echo cleaned"})

            raw = json.loads(f.read_text())
            hook_body = raw["hooks"]["PreToolUse"][0]["hooks"][0]
            assert hook_body["command"] == "echo cleaned"
            assert "flow_metadata" not in hook_body
        finally:
            set_default_records_root(original)

    def test_update_nonexistent_raises(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        with pytest.raises(KeyError):
            rl.update("nonexistent", {"command": "x"})


class TestDelete:
    def test_delete_hook(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        # Delete the first hook (PreToolUse/Bash/0)
        first = list(rl)[0]
        deleted = rl.delete_record(first.id)
        assert deleted is True

        raw = json.loads(f.read_text())
        # First group should now have 1 hook (the second one survived)
        assert len(raw["hooks"]["PreToolUse"][0]["hooks"]) == 1
        assert raw["hooks"]["PreToolUse"][0]["hooks"][0]["command"] == "echo second"

    def test_delete_last_hook_removes_group(self, tmp_path):
        """Deleting the last hook in a group removes the group."""
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo only"}]},
                ],
            },
        }))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        first = list(rl)[0]
        rl.delete_record(first.id)

        raw = json.loads(f.read_text())
        assert "hooks" not in raw

    def test_delete_nonexistent_returns_false(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert rl.delete_record("nonexistent") is False


class TestCreate:
    def test_create_hook_in_existing_event(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        rec = rl.create({
            "source_file": str(f),
            "event_type": "PreToolUse",
            "matcher": "Bash",
            "command": "echo new-hook",
        })

        assert rec.event_type == "PreToolUse"
        assert rec.command == "echo new-hook"
        assert len(rec.id) == 36  # uuid5  # stable hash ID

        raw = json.loads(f.read_text())
        bash_group = raw["hooks"]["PreToolUse"][0]
        # Should have 3 hooks now (2 original + 1 new)
        assert len(bash_group["hooks"]) == 3
        assert bash_group["hooks"][2]["command"] == "echo new-hook"
        # No flow_metadata written
        assert "flow_metadata" not in bash_group["hooks"][2]

    def test_create_hook_new_event(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"model": "test"}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        rec = rl.create({
            "source_file": str(f),
            "event_type": "SessionStart",
            "command": "echo hello",
        })

        assert rec.event_type == "SessionStart"

        raw = json.loads(f.read_text())
        assert "SessionStart" in raw["hooks"]
        assert raw["hooks"]["SessionStart"][0]["hooks"][0]["command"] == "echo hello"
        # Preserve existing keys
        assert raw["model"] == "test"

    def test_create_requires_source_file(self, tmp_path):
        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        with pytest.raises(ValueError, match="source_file"):
            rl.create({"event_type": "PreToolUse", "command": "echo x"})

    def test_create_requires_event_type(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text("{}")

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        with pytest.raises(ValueError, match="event_type"):
            rl.create({"source_file": str(f), "command": "echo x"})


# ---------------------------------------------------------------------------
# TestMetadata (save_meta_only)
# ---------------------------------------------------------------------------


class TestMetadata:
    def _save_overlay(self, rec):
        """Save record data to the overlay (default_path/data.json).

        ClaudeHookRecord.source_file points to settings.json,
        so we save to default_path instead.
        """
        from flow_sdk.fs_store.record import _DATA_JSON
        dp = rec.default_path
        if dp is None:
            raise ValueError("No default_path — record has no type")
        data_file = dp / _DATA_JSON
        orig_sf = rec.source_file
        orig_path = rec.path
        try:
            rec.path = str(dp)
            rec.save_record_json(data_file)
        finally:
            rec.source_file = orig_sf
            rec.path = orig_path

    def test_save_creates_data_overlay(self, tmp_path):
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

            records = _parse_hooks_from_file(f, "user")
            first = records[0]
            self._save_overlay(first)

            dp = first.default_path
            assert dp is not None
            assert (dp / "data.json").exists()
        finally:
            set_default_records_root(original)

    def test_management_fields_round_trip(self, tmp_path):
        """Management fields survive save → from_dict round-trip."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            records = _parse_hooks_from_file(f, "user")
            rec = records[0]
            self._save_overlay(rec)

            # Read back the saved data.json
            data_json_path = rec.default_path / "data.json"
            assert data_json_path.exists()

            raw = json.loads(data_json_path.read_text())
            saved_data = raw.get("data", raw)
            restored = ClaudeHookRecord.from_dict(saved_data)

            assert restored.flowpad_hook_id == "hook-abc-123"
            assert restored.flow_metadata_name == "My Managed Hook"
            assert hasattr(restored, "flowpad_hook_id")
            assert hasattr(restored, "flow_metadata_name")
        finally:
            set_default_records_root(original)


# ---------------------------------------------------------------------------
# TestOverlayMerge (step 4)
# ---------------------------------------------------------------------------


class TestOverlayMerge:
    """Step 4: Persisted metadata overlays are merged during discovery."""

    def _save_overlay(self, rec):
        """Save record data to the overlay (default_path/data.json)."""
        from flow_sdk.fs_store.record import _DATA_JSON
        dp = rec.default_path
        if dp is None:
            raise ValueError("No default_path — record has no type")
        data_file = dp / _DATA_JSON
        orig_sf = rec.source_file
        orig_path = rec.path
        try:
            rec.path = str(dp)
            rec.save_record_json(data_file)
        finally:
            rec.source_file = orig_sf
            rec.path = orig_path

    def test_overlay_name_wins(self, tmp_path):
        """Custom name saved to overlay wins over auto-generated name."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

            # First discovery — save overlay with custom name
            records = ClaudeHookRecord.discover(search_paths=[tmp_path])
            first = records[0]
            first.name = "My Custom Name"
            self._save_overlay(first)

            # Second discovery — overlay name should be merged
            records2 = ClaudeHookRecord.discover(search_paths=[tmp_path])
            match = [r for r in records2 if r.id == first.id][0]
            assert match.name == "My Custom Name"
        finally:
            set_default_records_root(original)

    def test_overlay_management_fields_merged(self, tmp_path):
        """Management fields from overlay are restored on rediscovery."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

            # Save overlay with management fields
            records = ClaudeHookRecord.discover(search_paths=[tmp_path])
            first = records[0]
            first.plugin_name = "test-plugin"
            first.flowpad_hook_id = "fp-999"
            first.flow_metadata_name = "Saved Name"
            self._save_overlay(first)

            # Rediscover — fields should be merged from overlay
            records2 = ClaudeHookRecord.discover(search_paths=[tmp_path])
            match = [r for r in records2 if r.id == first.id][0]
            assert match.plugin_name == "test-plugin"
            assert match.flowpad_hook_id == "fp-999"
            assert match.flow_metadata_name == "Saved Name"
        finally:
            set_default_records_root(original)

    def test_overlay_not_present_no_error(self, tmp_path):
        """Discovery works fine when no overlay exists."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_SETTINGS))

            records = ClaudeHookRecord.discover(search_paths=[tmp_path])
            assert len(records) == 4
            # No overlay → auto-generated name
            assert records[0].name == "PreToolUse (Bash)"
        finally:
            set_default_records_root(original)


# ---------------------------------------------------------------------------
# TestFlowMetadataMigration (step 5)
# ---------------------------------------------------------------------------


class TestFlowMetadataMigration:
    """Step 5: flow_metadata is migrated from source to overlay on discovery."""

    def test_migration_creates_overlay(self, tmp_path):
        """Discovery auto-creates overlay for hooks with flow_metadata."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            records = ClaudeHookRecord.discover(search_paths=[tmp_path])
            assert len(records) == 1
            rec = records[0]

            # Overlay should have been auto-created
            dp = rec.default_path
            assert dp is not None
            assert (dp / "data.json").exists()
        finally:
            set_default_records_root(original)

    def test_migration_strips_flow_metadata_from_source(self, tmp_path):
        """flow_metadata is stripped from settings.json after migration."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            ClaudeHookRecord.discover(search_paths=[tmp_path])

            raw = json.loads(f.read_text())
            hook_body = raw["hooks"]["PreToolUse"][0]["hooks"][0]
            assert "flow_metadata" not in hook_body
            # Domain fields preserved
            assert hook_body["command"] == "echo managed-hook"
            assert hook_body["type"] == "command"
        finally:
            set_default_records_root(original)

    def test_migration_preserves_management_fields(self, tmp_path):
        """Migrated fields are available via properties after discovery."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            records = ClaudeHookRecord.discover(search_paths=[tmp_path])
            rec = records[0]
            assert rec.flowpad_hook_id == "hook-abc-123"
            assert rec.flow_metadata_name == "My Managed Hook"
            assert rec.name == "My Managed Hook"
        finally:
            set_default_records_root(original)

    def test_migration_idempotent(self, tmp_path):
        """Second discovery does not re-modify the source file."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            # First discovery — migrates
            ClaudeHookRecord.discover(search_paths=[tmp_path])
            mtime1 = f.stat().st_mtime

            # Touch file to get a new mtime if it's rewritten
            import time
            time.sleep(0.05)

            # Second discovery — should NOT rewrite the file
            ClaudeHookRecord.discover(search_paths=[tmp_path])
            mtime2 = f.stat().st_mtime

            assert mtime1 == mtime2
        finally:
            set_default_records_root(original)

    def test_migration_fields_survive_rediscovery(self, tmp_path):
        """After migration, overlay fields are restored on rediscovery (step 4+5)."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(SAMPLE_HOOKS_WITH_FLOW_METADATA))

            # First discovery — migrates flow_metadata to overlay
            records1 = ClaudeHookRecord.discover(search_paths=[tmp_path])
            rec_id = records1[0].id

            # Second discovery — flow_metadata gone from source, loaded from overlay
            records2 = ClaudeHookRecord.discover(search_paths=[tmp_path])
            match = [r for r in records2 if r.id == rec_id][0]
            assert match.flowpad_hook_id == "hook-abc-123"
            assert match.flow_metadata_name == "My Managed Hook"
            assert match.name == "My Managed Hook"
        finally:
            set_default_records_root(original)

    def test_migration_only_affects_hooks_with_flow_metadata(self, tmp_path):
        """Hooks without flow_metadata are not touched."""
        from flow_sdk.fs_store import set_default_records_root, get_default_records_root

        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            mixed = {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Bash",
                            "hooks": [
                                {"type": "command", "command": "echo plain"},
                                {
                                    "type": "command",
                                    "command": "echo managed",
                                    "flow_metadata": {"name": "Managed", "flowpad_hook_id": "fp-1"},
                                },
                            ],
                        },
                    ],
                },
            }
            f = tmp_path / "settings.json"
            f.write_text(json.dumps(mixed))

            records = ClaudeHookRecord.discover(search_paths=[tmp_path])

            plain = [r for r in records if r.command == "echo plain"][0]
            managed = [r for r in records if r.command == "echo managed"][0]

            # Only the managed hook should have an overlay
            plain_dp = plain.default_path
            managed_dp = managed.default_path
            assert plain_dp is None or not (plain_dp / "data.json").exists()
            assert managed_dp is not None and (managed_dp / "data.json").exists()

            # Source: flow_metadata stripped from managed hook only
            raw = json.loads(f.read_text())
            hooks = raw["hooks"]["PreToolUse"][0]["hooks"]
            assert "flow_metadata" not in hooks[0]  # plain — never had it
            assert "flow_metadata" not in hooks[1]  # managed — stripped
        finally:
            set_default_records_root(original)


# ---------------------------------------------------------------------------
# TestImports
# ---------------------------------------------------------------------------


class TestImports:
    def test_import_from_claude_init(self):
        from flow_sdk.fs_records.claude import (
            ClaudeHookRecord,
            ClaudeHookRecordList,
        )
        assert ClaudeHookRecord is not None
        assert ClaudeHookRecordList is not None

    def test_import_from_fs_records(self):
        from flow_sdk.fs_records import ClaudeHookRecord, ClaudeHookRecordList
        assert ClaudeHookRecord is not None
        assert ClaudeHookRecordList is not None

    def test_record_type_exists(self):
        assert RecordType.CLAUDE_HOOK == "claude_hook"

    def test_type_registry(self):
        from flow_sdk.fs_store.factory.type_registry import type_registry
        assert type_registry.get(RecordType.CLAUDE_HOOK) is ClaudeHookRecord


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# TestSnifferDetection
# ---------------------------------------------------------------------------


class TestSnifferDetection:
    """Sniffer hooks are identified by --name=flowpad_sniffer in the command."""

    def test_sniffer_hooks_get_flow_metadata_name(self, tmp_path):
        """Hooks with --name=flowpad_sniffer get flow_metadata_name auto-set."""
        settings = {
            "hooks": {
                "SessionStart": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "flow hooks report --hook-entry-id=abc-123 --name=flowpad_sniffer",
                            }
                        ],
                    }
                ],
                "PreToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "flow hooks report --hook-entry-id=abc-123 --name=flowpad_sniffer",
                            }
                        ],
                    }
                ],
            }
        }
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(settings))

        records = _parse_hooks_from_file(f, "user")
        assert len(records) == 2
        for rec in records:
            assert rec.flow_metadata_name == "flowpad_sniffer"
            assert rec.flowpad_hook_id == "abc-123"

    def test_non_sniffer_hooks_no_auto_name(self, tmp_path):
        """Normal hooks don't get flow_metadata_name auto-set."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {"type": "command", "command": "echo hello"},
                        ],
                    }
                ],
            }
        }
        f = tmp_path / "settings.json"
        f.write_text(json.dumps(settings))

        records = _parse_hooks_from_file(f, "user")
        assert len(records) == 1
        assert records[0].flow_metadata_name is None
        assert records[0].flowpad_hook_id is None

    def test_sniffer_grouping_via_discover(self, tmp_path):
        """All sniffer hooks discovered share the same flow_metadata_name for UI grouping."""
        events = ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "Stop"]
        hooks_section = {}
        for event in events:
            hooks_section[event] = [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "flow hooks report --hook-entry-id=xyz-789 --name=flowpad_sniffer",
                        }
                    ],
                }
            ]

        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"hooks": hooks_section}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        records = list(rl)

        assert len(records) == 5
        sniffer_names = {r.flow_metadata_name for r in records}
        assert sniffer_names == {"flowpad_sniffer"}

        hook_ids = {r.flowpad_hook_id for r in records}
        assert hook_ids == {"xyz-789"}


# TestEmptyHooks
# ---------------------------------------------------------------------------


class TestEmptyHooks:
    def test_no_hooks_key(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"model": "test"}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(list(rl)) == 0

    def test_empty_hooks_dict(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"hooks": {}}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(list(rl)) == 0

    def test_empty_file(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text("{}")

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(list(rl)) == 0

    def test_hooks_with_empty_event(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"hooks": {"PreToolUse": []}}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(list(rl)) == 0

    def test_hooks_with_empty_group(self, tmp_path):
        f = tmp_path / "settings.json"
        f.write_text(json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": []}]}}))

        rl = ClaudeHookRecordList(search_paths=[tmp_path])
        assert len(list(rl)) == 0


# ---------------------------------------------------------------------------
# TestPluginDiscovery
# ---------------------------------------------------------------------------

SAMPLE_PLUGIN_HOOKS = {
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {"type": "command", "command": "$CLAUDE_PLUGIN_ROOT/scripts/lint.sh"},
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/post.sh"},
                ],
            },
        ],
    },
}

SAMPLE_PLUGIN_REGISTRY = {
    "version": 2,
    "plugins": {
        "my-linter@marketplace": [
            {"installPath": "__PLACEHOLDER__"},
        ],
    },
}


class TestPluginDiscovery:
    def _setup_plugin(self, tmp_path):
        """Create a fake plugin registry and hooks file. Returns (claude_home, install_path)."""
        claude_home = tmp_path / ".claude"
        plugins_dir = claude_home / "plugins"
        plugins_dir.mkdir(parents=True)

        install_path = tmp_path / "plugins" / "my-linter"
        hooks_dir = install_path / "hooks"
        hooks_dir.mkdir(parents=True)
        (hooks_dir / "hooks.json").write_text(json.dumps(SAMPLE_PLUGIN_HOOKS))

        registry = json.loads(json.dumps(SAMPLE_PLUGIN_REGISTRY))
        registry["plugins"]["my-linter@marketplace"][0]["installPath"] = str(install_path)
        (plugins_dir / "installed_plugins.json").write_text(json.dumps(registry))

        return claude_home, install_path

    def test_plugin_hooks_discovered(self, tmp_path, monkeypatch):
        claude_home, install_path = self._setup_plugin(tmp_path)
        # Production code reads claude_home via get_instance_settings(); patch
        # the module-level reference inside claude_hook_record.
        import flow_sdk.fs_records.claude.claude_hook_record as _hook_mod
        fake = type("S", (), {"claude_home": claude_home, "user_home": tmp_path})()
        monkeypatch.setattr(_hook_mod, "get_instance_settings", lambda: fake)
        records = _parse_hooks_from_plugins()
        assert len(records) == 2

    def test_plugin_root_resolved(self, tmp_path, monkeypatch):
        claude_home, install_path = self._setup_plugin(tmp_path)
        import flow_sdk.fs_records.claude.claude_hook_record as _hook_mod
        fake = type("S", (), {"claude_home": claude_home, "user_home": tmp_path})()
        monkeypatch.setattr(_hook_mod, "get_instance_settings", lambda: fake)
        records = _parse_hooks_from_plugins()

        pre = [r for r in records if r.event_type == "PreToolUse"][0]
        post = [r for r in records if r.event_type == "PostToolUse"][0]

        # Both forms of $CLAUDE_PLUGIN_ROOT should be resolved
        assert "$CLAUDE_PLUGIN_ROOT" not in pre.command
        assert str(install_path) in pre.command
        assert "${CLAUDE_PLUGIN_ROOT}" not in post.command
        assert str(install_path) in post.command

    def test_plugin_name_set(self, tmp_path):
        claude_home, _ = self._setup_plugin(tmp_path)
        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            records = _parse_hooks_from_plugins()
        for r in records:
            assert r.plugin_name == "my-linter"
            assert r.plugin_name == "my-linter"

    def test_plugin_id_is_content_hash(self, tmp_path):
        """Plugin hook IDs use content_hash like all other hooks."""
        claude_home, _ = self._setup_plugin(tmp_path)
        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            records = _parse_hooks_from_plugins()
        for r in records:
            assert len(r.id) == 36  # uuid5

    def test_no_registry_file(self, tmp_path):
        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            assert _parse_hooks_from_plugins() == []

    def test_empty_registry(self, tmp_path):
        claude_home = tmp_path / ".claude" / "plugins"
        claude_home.mkdir(parents=True)
        (claude_home / "installed_plugins.json").write_text("{}")
        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            assert _parse_hooks_from_plugins() == []

    def test_plugin_no_hooks_file(self, tmp_path):
        """Plugin exists in registry but has no hooks/hooks.json."""
        claude_home = tmp_path / ".claude" / "plugins"
        claude_home.mkdir(parents=True)
        install_path = tmp_path / "plugins" / "empty-plugin"
        install_path.mkdir(parents=True)
        registry = {"version": 2, "plugins": {"empty@market": [{"installPath": str(install_path)}]}}
        (claude_home / "installed_plugins.json").write_text(json.dumps(registry))
        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            assert _parse_hooks_from_plugins() == []


# ---------------------------------------------------------------------------
# TestLegacyDiscovery
# ---------------------------------------------------------------------------


class TestLegacyDiscovery:
    @staticmethod
    def _scope_value(scope):
        return scope.value if hasattr(scope, "value") else str(scope)

    def test_legacy_claude_json(self, tmp_path, monkeypatch):
        """Hooks from ~/.claude.json are discovered with 'legacy' scope."""
        # Create ~/.claude.json with hooks
        legacy = tmp_path / ".claude.json"
        legacy.write_text(json.dumps({
            "hooks": {
                "PreToolUse": [
                    {"matcher": "*", "hooks": [{"type": "command", "command": "echo legacy"}]},
                ],
            },
        }))

        # Create empty ~/.claude/ so _default_search_paths doesn't fail
        (tmp_path / ".claude").mkdir()

        # Patch get_instance_settings inside claude_hook_record so user_home /
        # claude_home resolve to tmp_path during discovery.
        import flow_sdk.fs_records.claude.claude_hook_record as _hook_mod
        fake = type(
            "S", (), {"claude_home": tmp_path / ".claude", "user_home": tmp_path}
        )()
        monkeypatch.setattr(_hook_mod, "get_instance_settings", lambda: fake)

        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            rl = ClaudeHookRecordList()
            records = list(rl)

        legacy_recs = [r for r in records if self._scope_value(r.scope) == "legacy"]
        assert len(legacy_recs) >= 1
        assert legacy_recs[0].command == "echo legacy"
        # ID is content_hash format
        assert len(legacy_recs[0].id) == 36  # uuid5

    def test_no_legacy_file(self, tmp_path):
        """No ~/.claude.json → no legacy records."""
        (tmp_path / ".claude").mkdir()

        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            rl = ClaudeHookRecordList()
            records = list(rl)

        legacy_recs = [r for r in records if self._scope_value(r.scope) == "legacy"]
        assert len(legacy_recs) == 0

    def test_legacy_not_scanned_with_explicit_search_paths(self, tmp_path):
        """Legacy and plugin scanning is skipped when search_paths is explicit."""
        legacy = tmp_path / ".claude.json"
        legacy.write_text(json.dumps({
            "hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo legacy"}]}]},
        }))

        search_dir = tmp_path / "explicit"
        search_dir.mkdir()
        (search_dir / "settings.json").write_text(json.dumps({
            "hooks": {"PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo explicit"}]}]},
        }))

        with mock.patch("pathlib.Path.home", return_value=tmp_path):
            rl = ClaudeHookRecordList(search_paths=[search_dir])
            records = list(rl)

        # Only the explicit search path should be scanned
        assert len(records) == 1
        assert records[0].command == "echo explicit"
