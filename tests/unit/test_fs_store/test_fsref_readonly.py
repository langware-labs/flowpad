"""Tests for FSRef read_only cascade via parent chain."""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.fs_ref import FSRef


class TestFSRefReadOnlyCascade:
    def test_no_parent_no_flag_is_not_read_only(self, tmp_path):
        child = FSRef(tmp_path / "file.txt")
        assert child.read_only is False

    def test_standalone_read_only_flag(self, tmp_path):
        ref = FSRef(tmp_path / "file.txt", read_only=True)
        assert ref.read_only is True

    def test_child_inherits_read_only_from_parent(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=True)
        child = parent.child("x")
        assert child.read_only is True

    def test_child_not_read_only_when_parent_not_read_only(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=False)
        child = parent.child("x")
        assert child.read_only is False

    def test_explicit_parent_read_only_cascades(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=True)
        child = FSRef(tmp_path / "dir" / "x", read_only=False, parent=parent)
        assert child.read_only is True

    def test_explicit_parent_not_read_only_child_flag_respected(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=False)
        child = FSRef(tmp_path / "dir" / "x", read_only=True, parent=parent)
        assert child.read_only is True

    def test_grandchild_cascades_from_grandparent(self, tmp_path):
        grandparent = FSRef(tmp_path / "root", read_only=True)
        child = grandparent.child("a")
        grandchild = child.child("b")
        assert grandchild.read_only is True

    def test_grandchild_not_read_only_when_grandparent_not_read_only(self, tmp_path):
        grandparent = FSRef(tmp_path / "root", read_only=False)
        child = grandparent.child("a")
        grandchild = child.child("b")
        assert grandchild.read_only is False

    def test_write_blocked_via_parent_cascade(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=True)
        child = parent.child("file.txt")
        with pytest.raises(IOError):
            child.write("content")

    def test_write_allowed_when_no_cascade(self, tmp_path):
        parent = FSRef(tmp_path / "dir", read_only=False)
        child = parent.child("file.txt")
        child.write("hello")
        assert (tmp_path / "dir" / "file.txt").read_text() == "hello"
