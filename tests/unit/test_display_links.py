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
async def test_plain_folder_opens_in_files_view(tmp_path):
    folder = tmp_path / "plain folder"
    folder.mkdir()
    source = Shell(workdir=str(tmp_path))
    for link in (str(folder), folder.as_uri(), "plain folder", f"{folder}/"):
        target = await resolve_display_target(link=link, source=source)
        assert target["kind"] == "dock"
        assert target["view_type"] == "explorer"
        assert "/" + target["pointer"].lstrip("/") == folder.resolve().as_posix()


@pytest.mark.asyncio
async def test_asset_folder_keeps_its_editor(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "folder-probe" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: folder-probe\ndescription: Folder test\n---\n# Folder probe\n")
    await resolve_display_target(path=str(skill), discover=True)
    target = await resolve_display_target(link=str(skill.parent))
    assert target["kind"] == "entity"
    assert target["type"] == "skill"


@pytest.mark.asyncio
async def test_process_source_resolves_where_its_shell_is_then_its_own_folders(tmp_path):
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.project import Project

    shell_dir, work_dir, project_dir = (tmp_path / name for name in ("shell", "work", "project"))
    for folder in (shell_dir, work_dir, project_dir):
        folder.mkdir()
    (shell_dir / "both.txt").write_text("shell")
    (work_dir / "both.txt").write_text("work")
    (work_dir / "work.txt").write_text("work")
    (project_dir / "notes.md").write_text("project")
    project = Project(name="process link project", fs_storage_mount_path=str(project_dir))
    await project.save()
    shell = Shell(workdir=str(shell_dir))
    await shell.save()
    process = AgenticProcess(workdir=str(work_dir), project_id=project.id, shell_id=shell.id)

    async def path_of(link):
        return (await resolve_display_target(link=link, source=process))["path"]

    assert await path_of("both.txt") == str((shell_dir / "both.txt").resolve())
    assert await path_of("work.txt") == str((work_dir / "work.txt").resolve())
    assert await path_of("notes.md") == str((project_dir / "notes.md").resolve())
    with pytest.raises(DisplayTargetNotFound):
        await path_of("missing.txt")


@pytest.mark.asyncio
async def test_process_without_a_shell_uses_its_workdir(tmp_path):
    from flow_sdk.builtin.agentic_process import AgenticProcess

    (tmp_path / "a.py").write_text("print(1)\n")
    target = await resolve_display_target(link="a.py:1", source=AgenticProcess(workdir=str(tmp_path)))
    assert (target["path"], target["line"]) == (str((tmp_path / "a.py").resolve()), 1)


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
