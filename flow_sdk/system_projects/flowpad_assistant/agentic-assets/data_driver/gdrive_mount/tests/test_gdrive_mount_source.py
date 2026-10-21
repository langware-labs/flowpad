"""The mounted-Drive driver: a dataset's rows in the Drive folder on this computer, set up in steps.

Drive for desktop is stood in for by a folder (``mount_root``) -- the driver only ever sees files.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.sources.binding import SourceBinding


@pytest.fixture
async def driver():
    return await DataDriver.find("gdrive_mount")


@pytest.fixture
def installed(monkeypatch, driver):
    """Drive for desktop counts as installed (the app's presence is the only machine fact asked)."""
    module = __import__(driver.cls.__module__, fromlist=["installed"])
    monkeypatch.setattr(module, "installed", lambda: True)
    return module


def _source(driver, config, *, holds_rows=True):
    config = {**config, **driver.cls.configure(type("Row", (), {"config": config})())}
    return driver.cls(SourceBinding(source_id="s", config=config, holds_rows=holds_rows))


def test_a_dataset_lives_in_the_drive_folder_on_this_computer(driver, tmp_path):
    my_drive = tmp_path / "My Drive"
    my_drive.mkdir()
    config = {"path": "Sales Desk", "mount_root": str(my_drive)}
    assert driver.cls.rows_folder(config, "gtm-personas") == my_drive / "Sales Desk" / "gtm-personas"
    assert driver.cls.rows_within(config, "gtm-personas")["path"] == "Sales Desk/gtm-personas"


def test_without_drive_for_desktop_there_is_no_folder_to_name(driver, tmp_path):
    with pytest.raises(ValueError, match="not set up on this computer"):
        driver.cls.rows_folder({"path": "GTM", "mount_root": str(tmp_path / "missing")}, "x")


async def test_setup_says_what_is_missing_then_holds(driver, installed, tmp_path, monkeypatch):
    my_drive = tmp_path / "My Drive"
    config = {"path": "Sales Desk", "mount_root": str(my_drive)}

    monkeypatch.setattr(installed, "installed", lambda: False)
    assert "not installed" in (await _source(driver, config).verify()).detail

    monkeypatch.setattr(installed, "installed", lambda: True)
    assert "Sign in" in (await _source(driver, config).verify()).detail             # no My Drive yet

    my_drive.mkdir()
    assert "no folder" in (await _source(driver, config, holds_rows=False).verify()).detail
    verdict = await _source(driver, config).verify()                                 # a source holding rows makes it
    assert verdict.ready is True and (my_drive / "Sales Desk").is_dir()
    assert not list((my_drive / "Sales Desk").iterdir())                             # the write probe left nothing


async def test_the_steps_report_and_do_their_part(driver, installed, tmp_path):
    my_drive = tmp_path / "My Drive"
    config = {"path": "Sales Desk", "mount_root": str(my_drive)}
    source = _source(driver, config)
    assert (await source._install(check=True, values={})).ok                         # installed (stood in)
    assert not (await source._sign_in(check=True, values={})).ok
    assert not (await source._make_folder(check=False, values={})).ok                     # nothing to make it in yet
    my_drive.mkdir()
    assert (await source._sign_in(check=True, values={})).ok
    assert not (await source._make_folder(check=True, values={})).ok
    assert (await source._make_folder(check=False, values={})).ok and (my_drive / "Sales Desk").is_dir()


async def test_rows_written_in_the_mounted_folder_and_the_api_layout_agree(tmp_path, monkeypatch):
    """The same dataset in a mounted source keeps its rows as ``<folder>/<dataset>/rows/<key>/row.json`` --
    the layout the API driver keeps in Drive, so moving a source between the two moves no data."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import locations
    from flow_sdk.schema.data_spec.declared import load_root
    from tests.unit._graph_client import call_local
    from tests.unit.test_data_spec.test_file_location import _schema

    root, ns = tmp_path / "proj", "unittestmount" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.person", {"name": {"shape": "string", "description": "x"}})
    assert not any(load_root(root).values())
    my_drive = tmp_path / "My Drive"
    (my_drive / "Sales Desk").mkdir(parents=True)
    folder = root / "agentic-assets" / "data_source" / "drive"
    folder.mkdir(parents=True)
    (folder / "data_source.json").write_text(json.dumps({"type": "data_source", "name": "drive", "data_driver_name": "gdrive_mount",
                                                         "data_driver_config": {"path": "Sales Desk", "mount_root": str(my_drive)}}))

    async def ready(name, project_id=""):
        return ""

    monkeypatch.setattr(locations, "source_refusal", ready)
    locations._checked.clear()
    people = Dataset(id=str(uuid.uuid4()), name="people", asset_ref=str(root / "agentic-assets/dataset/people"),
                     data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.person"}]}, data_source="drive")
    Path(people.asset_ref).mkdir(parents=True)
    await people.save()

    put = await call_local("POST", f"dataset/{people.id}/put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 200, put.text
    assert (my_drive / "Sales Desk" / "people" / "rows" / "ada" / "row.json").is_file()   # in place, in Drive's folder
    assert not list(Path(people.asset_ref).rglob("row.json"))                              # no row kept locally
    assert people._location().kind == "folder" and people.rows_at == "drive · people"
