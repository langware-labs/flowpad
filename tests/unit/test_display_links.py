"""Real reference resolution, without a browser or worker."""

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.core.display_target import DisplayTargetNotFound, InvalidDisplayTarget, resolve_display_target


@pytest.mark.asyncio
async def test_local_file_forms_and_positions(tmp_path):
    file = tmp_path / "hello world.py"
    file.write_text("print('hello')\n")
    source = Shell(workdir=str(tmp_path))
    for link in (str(file), file.as_uri(), "hello world.py"):
        target = await resolve_display_target(link=link, source=source)
        assert target == {"kind": "vfs", "path": str(file.resolve())}
    target = await resolve_display_target(link=f"{file}:2:3", source=source)
    assert (target["line"], target["column"], target["path"]) == (2, 3, str(file.resolve()))


@pytest.mark.asyncio
async def test_project_root_fallback(tmp_path):
    from flow_sdk.builtin.project import Project

    project = Project(name="link project", fs_storage_mount_path=str(tmp_path))
    await project.save()
    file = tmp_path / "notes.txt"
    file.write_text("project root")
    source = Shell(workdir=str(tmp_path / "subdir"), project_id=project.id)
    target = await resolve_display_target(link="notes.txt", source=source)
    assert target["path"] == str(file.resolve())


@pytest.mark.asyncio
async def test_skill_uses_existing_entity_resolution(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "link-probe" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: link-probe\ndescription: Link test\n---\n# Link probe\n")
    shown = await resolve_display_target(path=str(skill), discover=True)
    clicked = await resolve_display_target(link=str(skill), discover=True)
    assert clicked == shown
    assert clicked["kind"] == "entity"
    assert clicked["type"] == "skill"


@pytest.mark.asyncio
async def test_url_dock_and_entity_references():
    url = "https://example.org/page?x=1#section"
    assert await resolve_display_target(link=url) == {"kind": "url", "url": url}
    dock = await resolve_display_target(link="/dock/preferences/appearance?highlight=Theme")
    assert dock["kind"] == "dock"
    assert dock["options"]["highlight"] == "Theme"
    source = Shell(name="entity link")
    await source.save()
    target = await resolve_display_target(link=str(source.typeid))
    assert target["kind"] == "shell"
    assert target["id"] == source.id


@pytest.mark.asyncio
@pytest.mark.parametrize("link", ["", "javascript:alert(1)", "data:text/html,hello", "https:///missing-host", "file://other-host/tmp/test"])
async def test_invalid_links(link):
    with pytest.raises(InvalidDisplayTarget):
        await resolve_display_target(link=link)


@pytest.mark.asyncio
async def test_missing_file_does_not_use_server_cwd(tmp_path):
    with pytest.raises(DisplayTargetNotFound):
        await resolve_display_target(link="pyproject.toml", source=Shell(workdir=str(tmp_path)))
    with pytest.raises(DisplayTargetNotFound):
        await resolve_display_target(link=str(tmp_path / "missing.txt"))
