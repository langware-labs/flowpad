"""Byte-transfer safety independent of messages, scopes, and the database."""
import pytest

from flow_sdk.assets.transfer import AssetTransferConflict, remove_transferred_tree, restore_tree


def test_conflict_does_not_partially_install_other_files(tmp_path):
    source, destination = tmp_path / "bundle", tmp_path / "target"
    source.mkdir()
    destination.mkdir()
    (source / "new.txt").write_text("new")
    (source / "existing.txt").write_text("incoming")
    (destination / "existing.txt").write_text("keep")
    with pytest.raises(AssetTransferConflict):
        restore_tree(source, destination, overwrite=False)
    assert not (destination / "new.txt").exists()
    assert (destination / "existing.txt").read_text() == "keep"


def test_restore_is_idempotent_and_remove_keeps_untracked_files(tmp_path):
    source, destination = tmp_path / "bundle", tmp_path / "target"
    source.mkdir()
    (source / "asset.txt").write_text("body")
    assert restore_tree(source, destination, overwrite=False)
    assert not restore_tree(source, destination, overwrite=False)
    (destination / "untracked.txt").write_text("keep")
    remove_transferred_tree(source, destination)
    assert not (destination / "asset.txt").exists()
    assert (destination / "untracked.txt").read_text() == "keep"


def test_restore_does_not_follow_destination_symlink_outside_root(tmp_path):
    source, destination, outside = tmp_path / "bundle", tmp_path / "target", tmp_path / "outside"
    source.mkdir()
    destination.mkdir()
    outside.mkdir()
    (source / "nested").mkdir()
    (source / "nested" / "file").write_text("incoming")
    (outside / "file").write_text("keep")
    (destination / "nested").symlink_to(outside, target_is_directory=True)
    assert not restore_tree(source, destination, overwrite=True)
    assert (outside / "file").read_text() == "keep"
