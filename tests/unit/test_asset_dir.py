from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.asset_dir import AssetDir


def test_asset_dir_loads_text_bytes_files_and_dirs(tmp_path):
    assets = AssetDir(tmp_path / "assets")

    text_path = assets.load_asset("CLAUDE.md", content="system text\n")
    bytes_path = assets.load_asset("blob.bin", content=b"\x00\x01")

    source_file = tmp_path / "source.txt"
    source_file.write_text("from file", encoding="utf-8")
    copied_file = assets.load_asset("copied/source.txt", source=source_file)

    source_dir = tmp_path / "source_dir"
    source_dir.mkdir()
    (source_dir / "keep.md").write_text("keep", encoding="utf-8")
    (source_dir / "record.json").write_text("ignored", encoding="utf-8")
    copied_dir = assets.load_asset(".claude/agents/demo", source=source_dir)

    assert text_path == tmp_path / "assets" / "CLAUDE.md"
    assert text_path.read_text(encoding="utf-8") == "system text\n"
    assert bytes_path.read_bytes() == b"\x00\x01"
    assert copied_file.read_text(encoding="utf-8") == "from file"
    assert (copied_dir / "keep.md").read_text(encoding="utf-8") == "keep"
    assert not (copied_dir / "record.json").exists()


@pytest.mark.parametrize("bad_path", ["/absolute.md", "../escape.md", Path("ok") / ".." / "escape.md"])
def test_asset_dir_rejects_paths_outside_root(tmp_path, bad_path):
    assets = AssetDir(tmp_path / "assets")

    with pytest.raises(ValueError):
        assets.load_asset(bad_path, content="nope")


def test_asset_dir_requires_one_source(tmp_path):
    assets = AssetDir(tmp_path / "assets")

    with pytest.raises(ValueError):
        assets.load_asset("missing.md")
    with pytest.raises(ValueError):
        assets.load_asset("too-many.md", content="x", source=tmp_path)


def test_asset_dir_subdir_and_remove_stay_inside_owned_root(tmp_path):
    assets = AssetDir(tmp_path / "assets")
    plugin = assets.subdir(".flowpad/plugins/claude")
    plugin.load_asset("marker", content="owned")

    assert plugin.os_path == tmp_path / "assets" / ".flowpad" / "plugins" / "claude"
    assets.remove(".flowpad/plugins/claude")
    assert not plugin.os_path.exists()


def test_asset_dir_subdir_rejects_symlink_escape(tmp_path):
    assets = AssetDir(tmp_path / "assets")
    outside = tmp_path / "outside"
    outside.mkdir()
    assets.os_path.mkdir()
    (assets.os_path / "linked").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError):
        assets.subdir("linked/created/plugin")
    assert not (outside / "created").exists()
