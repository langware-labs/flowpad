"""Tests for JSONFsRef, TextFsRef, and FSRef read_only support."""
from __future__ import annotations

import json
import pytest
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef, JSONFsRef, TextFsRef


# ---------------------------------------------------------------------------
# JSONFsRef tests
# ---------------------------------------------------------------------------

class TestJSONFsRefNonExistent:
    def test_get_nonexistent_file_returns_empty(self, tmp_path):
        ref = JSONFsRef(tmp_path / "missing.json")
        assert ref.as_dict() == {}

    def test_get_key_on_nonexistent_file_returns_default(self, tmp_path):
        ref = JSONFsRef(tmp_path / "missing.json")
        assert ref.get("foo") is None
        assert ref.get("foo", "bar") == "bar"


class TestJSONFsRefSet:
    def test_set_creates_file_in_wrapped_format(self, tmp_path):
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.set("key", "val")

        assert path.exists()
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert "data" in raw
        assert raw["data"]["key"] == "val"

    def test_get_returns_cached_value_after_set(self, tmp_path):
        ref = JSONFsRef(tmp_path / "data.json")
        ref.set("key", "val")
        assert ref.get("key") == "val"

    def test_set_multiple_keys(self, tmp_path):
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.set("a", 1)
        ref.set("b", 2)

        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["data"] == {"a": 1, "b": 2}


class TestJSONFsRefLoad:
    def test_load_force_rereads_from_disk(self, tmp_path):
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.set("key", "original")

        # Write directly to disk bypassing cache
        path.write_text(
            json.dumps({"data": {"key": "updated"}}),
            encoding="utf-8",
        )

        # Cache still holds old value
        assert ref.get("key") == "original"

        # After load(), cache is refreshed
        result = ref.load()
        assert result["key"] == "updated"
        assert ref.get("key") == "updated"

    def test_load_returns_dict_copy(self, tmp_path):
        ref = JSONFsRef(tmp_path / "data.json")
        ref.set("x", 42)
        d = ref.load()
        d["x"] = 99
        # Mutating the returned dict does not affect the internal cache
        assert ref.get("x") == 42


class TestJSONFsRefUpdate:
    def test_update_sets_multiple_keys(self, tmp_path):
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.update({"a": 1, "b": 2})

        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["data"] == {"a": 1, "b": 2}

    def test_update_merges_with_existing(self, tmp_path):
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.set("existing", "keep")
        ref.update({"new": "added"})

        assert ref.get("existing") == "keep"
        assert ref.get("new") == "added"


class TestJSONFsRefReadOnly:
    def test_set_raises_ioerror_when_read_only(self, tmp_path):
        ref = JSONFsRef(tmp_path / "data.json", read_only=True)
        with pytest.raises(IOError):
            ref.set("key", "val")

    def test_update_raises_ioerror_when_read_only(self, tmp_path):
        ref = JSONFsRef(tmp_path / "data.json", read_only=True)
        with pytest.raises(IOError):
            ref.update({"key": "val"})

    def test_write_allows_raw_text(self, tmp_path):
        """JSONFsRef.write() allows raw text writes and invalidates the JSON cache."""
        path = tmp_path / "data.json"
        ref = JSONFsRef(path)
        ref.write('{"data": {"key": "via-write"}}')
        assert path.read_text(encoding="utf-8") == '{"data": {"key": "via-write"}}'
        # Cache should be invalidated; as_dict() re-reads from disk
        assert ref.as_dict() == {"key": "via-write"}

    def test_write_raises_ioerror_when_read_only(self, tmp_path):
        ref = JSONFsRef(tmp_path / "data.json", read_only=True)
        with pytest.raises(IOError):
            ref.write("raw content")


# ---------------------------------------------------------------------------
# TextFsRef tests
# ---------------------------------------------------------------------------

class TestTextFsRef:
    def test_write_works_normally(self, tmp_path):
        path = tmp_path / "text.txt"
        ref = TextFsRef(path)
        ref.write("hello")
        assert path.read_text() == "hello"

    def test_read_only_raises_ioerror(self, tmp_path):
        path = tmp_path / "text.txt"
        path.write_text("existing")
        ref = TextFsRef(path, read_only=True)
        with pytest.raises(IOError):
            ref.write("new content")

    def test_read_still_works_when_read_only(self, tmp_path):
        path = tmp_path / "text.txt"
        path.write_text("hello")
        ref = TextFsRef(path, read_only=True)
        assert ref.read() == "hello"


# ---------------------------------------------------------------------------
# FSRef read_only tests
# ---------------------------------------------------------------------------

class TestFSRefReadOnly:
    def test_write_raises_ioerror_when_read_only(self, tmp_path):
        ref = FSRef(tmp_path / "file.txt", read_only=True)
        with pytest.raises(IOError):
            ref.write("content")

    def test_write_md_raises_ioerror_when_read_only(self, tmp_path):
        ref = FSRef(tmp_path / "file.md", read_only=True)
        with pytest.raises(IOError):
            ref.write_md("body", {"title": "test"})

    def test_child_propagates_read_only(self, tmp_path):
        ref = FSRef(tmp_path / "dir", read_only=True)
        child = ref.child("file.txt")
        assert child.read_only is True

    def test_child_propagates_not_read_only(self, tmp_path):
        ref = FSRef(tmp_path / "dir", read_only=False)
        child = ref.child("file.txt")
        assert child.read_only is False

    def test_read_only_flag_default_is_false(self, tmp_path):
        ref = FSRef(tmp_path / "file.txt")
        assert ref._read_only_flag is False
        assert ref.read_only is False

    def test_write_works_when_not_read_only(self, tmp_path):
        path = tmp_path / "file.txt"
        ref = FSRef(path)
        ref.write("hello")
        assert path.read_text() == "hello"
