"""``source_gone``: a row whose file is deleted is gone — even with its whole folder;
a file on a volume that is not there is not."""
from __future__ import annotations

from flow_sdk.fs_store.path_utils import source_gone, source_unreachable


def test_a_deleted_file_is_gone(tmp_path):
    assert source_gone(str(tmp_path / "deleted.md"))


def test_a_file_whose_whole_folder_was_deleted_is_gone(tmp_path):
    ref = tmp_path / "project" / "docs" / "page.md"
    assert not source_unreachable(str(ref))
    assert source_gone(str(ref))


def test_a_file_that_exists_is_not_gone(tmp_path):
    ref = tmp_path / "here.md"
    ref.write_text("x")
    assert not source_gone(str(ref))


def test_a_file_on_a_missing_volume_cannot_be_told(tmp_path):
    ref = "/Volumes/flowpad-no-such-volume/project/page.md"
    assert source_unreachable(ref)
    assert not source_gone(ref)


def test_an_empty_ref_is_not_gone():
    assert not source_gone("")
