"""Folder → zip for the "Download as zip" tree action."""

import zipfile

from flow_sdk.actions.fs.fs_actions import _zip_folder


def test_zip_keeps_structure_and_empty_folders(tmp_path):
    root = tmp_path / "notes"
    (root / "archive").mkdir(parents=True)
    (root / "empty").mkdir()
    (root / "a.md").write_text("# a")
    (root / "archive" / "b.md").write_text("# b")

    with _zip_folder(root) as archive, zipfile.ZipFile(archive) as zf:
        names = set(zf.namelist())
        assert {"notes/a.md", "notes/archive/b.md", "notes/empty/"} <= names
        assert zf.read("notes/archive/b.md") == b"# b"


def test_zip_skips_broken_symlink(tmp_path):
    root = tmp_path / "d"
    root.mkdir()
    (root / "ok.md").write_text("x")
    (root / "dangling").symlink_to(tmp_path / "missing")

    with _zip_folder(root) as archive, zipfile.ZipFile(archive) as zf:
        assert zf.namelist() == ["d/ok.md"]
