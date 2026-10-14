"""No two visible projects share a name — on create, on rename, and when the indexer
turns a workspace folder into a project. Real SQLite, real ``Project.save``.

"sales desk" (renamed from "marketing") beside "sales-desk" was two projects with one
name: the rename ran no check, and names folded neither case nor separators."""

import dataclasses
import logging

import pytest

from flow_sdk.builtin.project import DuplicateProjectNameError, Project, project_name_key
from tests.unit.test_workspace_projects import project_db  # noqa: F401 — real SQLite fixture


def _project(tmp_path, name: str, folder: str | None = None) -> Project:
    return Project(name=name, fs_storage_mount_path=str(tmp_path / (folder or name)))


def test_name_key_folds_case_and_separators():
    assert project_name_key("Sales Desk") == project_name_key("sales-desk") == project_name_key("sales_desk")
    assert project_name_key(" sales  --desk ") == "sales-desk"
    assert project_name_key("sales-desk") != project_name_key("sales-desks")


@pytest.mark.asyncio
async def test_create_refuses_a_taken_name(project_db, tmp_path):  # noqa: F811
    await _project(tmp_path, "sales-desk").save()

    with pytest.raises(DuplicateProjectNameError, match="sales-desk"):
        await _project(tmp_path, "Sales Desk", folder="other").save()

    assert [p.name for p in await Project.get_all()] == ["sales-desk"]


@pytest.mark.asyncio
async def test_rename_refuses_a_taken_name(project_db, tmp_path):  # noqa: F811
    await _project(tmp_path, "sales-desk").save()
    marketing = await _project(tmp_path, "marketing").save()

    marketing.name = "sales desk"
    with pytest.raises(DuplicateProjectNameError):
        await marketing.save()

    stored = await Project._db.get_by_id(str(marketing.id), "project")
    assert stored.name == "marketing"


@pytest.mark.asyncio
async def test_renaming_to_a_variant_of_its_own_name_is_allowed(project_db, tmp_path):  # noqa: F811
    project = await _project(tmp_path, "sales-desk").save()

    project.name = "Sales Desk"
    await project.save()

    assert (await Project._db.get_by_id(str(project.id), "project")).name == "Sales Desk"


@pytest.mark.asyncio
async def test_rows_that_collided_before_the_rule_keep_saving(project_db, tmp_path):  # noqa: F811
    # Written the way pre-rule code did: straight through the entity base, no guard.
    older = _project(tmp_path, "sales-desk")
    await super(Project, older).save()
    newer = _project(tmp_path, "sales desk", folder="marketing")
    await super(Project, newer).save()

    newer.tab_order = 3  # an ordinary update that does not touch the name
    await newer.save()

    third = await _project(tmp_path, "other").save()
    third.name = "Sales_Desk"  # a rename onto the taken name is still refused
    with pytest.raises(DuplicateProjectNameError):
        await third.save()


@pytest.mark.asyncio
async def test_indexer_does_not_make_a_project_of_a_folder_with_a_taken_name(
    project_db, tmp_path, monkeypatch, caplog  # noqa: F811
):
    home = tmp_path / "home"
    ws = home / "Flowpad workspace"
    (ws / "sales_desk").mkdir(parents=True)
    (ws / "fresh").mkdir()
    await Project(name="sales-desk", fs_storage_mount_path=str(tmp_path / "elsewhere")).save()

    import flow_sdk.fs_store.operations.all_projects as ap
    import flow_sdk.instance_settings as isettings

    records_root = tmp_path / "records"
    records_root.mkdir(exist_ok=True)
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
        claude_projects_dir=home / ".claude" / "projects",
        codex_config_path=home / ".codex" / "config.toml",
        records_root=records_root,
    )
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr("flow_sdk.config.agent_workspace_root", lambda: ws)

    with caplog.at_level(logging.ERROR):
        await ap.get_all_projects(include_temp=True, create_missing=True)

    names = sorted(p.name for p in await Project.get_all())
    assert names == ["fresh", "sales-desk"]
    assert any("sales_desk" in r.getMessage() and r.levelno == logging.ERROR for r in caplog.records)


@pytest.mark.parametrize(
    ("name", "folder", "expected"),
    [
        ("sales-desk", "marketing", "marketing"),  # renamed: the folder kept its name
        ("sales desk", "sales-desk", None),  # same name as the key sees it
        ("Sales_Desk", "sales-desk", None),
    ],
)
def test_folder_name_mismatch_names_a_folder_the_rename_left_behind(tmp_path, name, folder, expected):
    project = Project(name=name, fs_storage_mount_path=str(tmp_path / folder))
    assert project.folder_name_mismatch == expected
    assert project.model_dump().get("folder_name_mismatch") == expected
