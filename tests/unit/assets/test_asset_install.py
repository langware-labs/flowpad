
import pytest

from flow_sdk.assets.materialize import MaterializationMode, materialize_asset


@pytest.mark.asyncio
async def test_copy_and_explicit_link(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_text("original")
    copy = await materialize_asset(source, tmp_path / "copy")
    link = await materialize_asset(source, tmp_path / "link", mode=MaterializationMode.LINK)
    (source / "SKILL.md").write_text("changed")
    assert (copy / "SKILL.md").read_text() == "original"
    assert link.is_symlink() and (link / "SKILL.md").read_text() == "changed"


@pytest.mark.asyncio
async def test_replacement_unlinks_without_deleting_source(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_text("content")
    target = await materialize_asset(source, tmp_path / "target", mode=MaterializationMode.LINK)
    with pytest.raises(FileExistsError):
        await materialize_asset(source, target)
    await materialize_asset(source, target, overwrite=True)
    assert not target.is_symlink() and (source / "SKILL.md").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("relative", [".", "child"])
async def test_overlapping_copy_is_refused(tmp_path, relative):
    with pytest.raises(ValueError, match="overlap"):
        await materialize_asset(tmp_path, tmp_path / relative, overwrite=True)
    assert tmp_path.exists()


@pytest.mark.asyncio
async def test_failed_copy_preserves_existing_destination(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "missing").symlink_to(tmp_path / "absent")
    destination = tmp_path / "destination"
    destination.mkdir()
    (destination / "keep").write_text("safe")
    with pytest.raises(OSError):
        await materialize_asset(source, destination, overwrite=True)
    assert (destination / "keep").read_text() == "safe"
