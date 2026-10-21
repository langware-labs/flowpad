"""A dataset whose rows live in a DATA SOURCE (``"data_source": <name>``): resolved from the project's
``data_source/<name>/data_source.json``, kept local while that source is not set up here, and
moved into it adopting what is already there."""

from __future__ import annotations

import contextlib
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.unit.test_data_spec.test_file_location import _Ordered, _schema


def _source(root: Path, name: str, driver: str = "mem", config: dict | None = None) -> None:
    folder = root / "agentic-assets" / "data_source" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "data_source.json").write_text(json.dumps(   # flat, as DataSourceSpec writes it
        {"type": "data_source", "name": name, "data_driver_name": driver, "data_driver_config": config or {"path": "GTM"}}))


@pytest.fixture
def project(tmp_path, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import locations

    root, ns = tmp_path / "proj", "unittestsrc" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.person", {"name": {"shape": "string", "description": "x"}})
    from flow_sdk.schema.data_spec.declared import load_root

    assert not any(load_root(root).values())
    _source(root, "drive")
    store, seen, refusal = _Ordered(), [], {"why": "drive needs setup: not verified"}

    @contextlib.asynccontextmanager
    async def opener(where):
        seen.append(where)
        yield store

    async def refused(name, project_id=""):
        return refusal["why"]

    monkeypatch.setattr(locations, "OPENER", opener)
    monkeypatch.setattr(locations, "source_refusal", refused)
    locations._ready.clear()
    locations._unready.clear()

    async def dataset(name="people", **fields):
        made = Dataset(id=str(uuid.uuid4()), name=name, asset_ref=str(root / "agentic-assets/dataset" / name),
                       data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.person"}]}, **fields)
        Path(made.asset_ref).mkdir(parents=True, exist_ok=True)
        await made.save()
        return made

    return SimpleNamespace(root=root, store=store, seen=seen, refusal=refusal, dataset=dataset)


async def _call(dataset, action, body):
    from tests.unit._graph_client import call_local

    return await call_local("POST", f"dataset/{dataset.id}/{action}", body)


def test_a_source_resolves_to_its_driver_config_and_the_dataset_folder(tmp_path):
    from flow_sdk.datasets.locations import declared, parse

    root = tmp_path / "p"
    _source(root, "drive")
    folder = root / "agentic-assets" / "dataset" / "gtm-personas"
    where = parse(declared(folder, "drive", None, None))
    assert (where.kind, where.driver, where.config, where.source, where.path) == ("files", "mem", {"path": "GTM"}, "drive", "gtm-personas")
    assert where.label() == "drive · gtm-personas"
    assert parse(declared(folder, "drive", "shared/people", None)).path == "shared/people"
    assert parse(declared(folder, "local", None, None)).kind == "local"
    with pytest.raises(ValueError, match="no data source 'nope'"):
        declared(folder, "nope", None, None)


def test_a_record_system_source_keeps_the_datasets_own_map(tmp_path):
    from flow_sdk.datasets.locations import declared, parse

    root = tmp_path / "p"
    _source(root, "crm", driver="twenty", config={"base_url": "https://crm"})
    shape = {"key": "external_id", "input": {"crm_id": "external_id", "name": "data.name"}}
    where = parse(declared(root / "agentic-assets/dataset/people", "crm", None,
                           {"config": {"resource": "people"}, "map": shape, "by": "crm"}))
    assert (where.kind, where.config, where.by, where.path) == ("records", {"base_url": "https://crm", "resource": "people"}, "crm", "")


async def test_drivers_place_a_dataset_inside_the_source():
    from flow_sdk.builtin.data_driver import DataDriver

    gdrive = (await DataDriver.find("gdrive")).cls
    assert gdrive.rows_within({"path": "Sales Desk/", "drive": "d"}, "gtm-personas") == {"path": "Sales Desk/gtm-personas", "drive": "d"}
    assert gdrive.rows_within({}, "people")["path"] == "people"
    s3 = (await DataDriver.find("s3")).cls
    assert s3.rows_within({"bucket": "b", "prefix": "gtm/"}, "people") == {"bucket": "b", "prefix": "gtm/people"}


async def test_rows_stay_local_while_the_source_is_not_set_up(project):
    people = await project.dataset(data_source="drive")
    put = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 200, put.text
    assert (Path(people.asset_ref) / "rows" / "ada" / "row.json").is_file()           # the default source: <dataset>/rows/
    assert not project.store.files and not project.seen                               # the source was never opened
    assert people._location().kind == "local"
    assert people.rows_note == "kept locally: drive needs setup: not verified"
    assert people.rows_at == "local"


async def test_rows_go_to_the_source_once_it_is_set_up(project):
    project.refusal["why"] = ""
    people = await project.dataset(data_source="drive")
    put = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 200, put.text
    assert {p.split("/")[1] for p in project.store.files} == {"ada"}
    assert (project.seen[-1].source, project.seen[-1].path, project.seen[-1].config) == ("drive", "people", {"path": "GTM"})
    people._location()   # this value re-reads the answer the source gave the action
    assert people.rows_note == "" and people.rows_at == "drive · people"


async def test_a_new_dataset_on_a_folder_with_rows_reads_them(project):
    project.refusal["why"] = ""
    first = await project.dataset("first", data_source="drive", path="shared")
    await _call(first, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    second = await project.dataset("second", data_source="drive", path="shared")             # the same folder: adopted
    rows = (await _call(second, "rows", {})).json()["data"]["rows"]
    assert [r["key"] for r in rows] == ["ada"]


async def test_rows_move_into_a_source_and_the_dataset_says_so(project):
    people = await project.dataset()
    await _call(people, "put-row", {"key": "bob", "row": {"input": {"name": "Bob"}}})
    refused = await _call(people, "move-rows", {"location": {"data_source": "drive"}})
    assert refused.status_code == 400 and "needs setup" in refused.text                 # not set up: nothing moves
    project.refusal["why"] = ""
    moved = await _call(people, "move-rows", {"location": {"data_source": "drive"}})
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"]["to"] == "drive · people"
    metadata = json.loads((Path(people.asset_ref) / "dataset.json").read_text())["metadata"]
    assert metadata.get("data_source") == "drive" and "location" not in metadata
    assert {p.split("/")[1] for p in project.store.files} == {"bob"}


async def test_a_source_knows_the_datasets_it_hosts(project):
    from flow_sdk.builtin.data_source import DataSource

    name = "drive" + uuid.uuid4().hex[:8]   # the index is shared across tests: a name of its own
    _source(project.root, name)
    await project.dataset("a", data_source=name)
    await project.dataset("b", data_source=name)
    await project.dataset("c")
    drive = DataSource(id=str(uuid.uuid4()), name=name, provider="mem")
    assert sorted(d.name for d in await drive.datasets()) == ["a", "b"]
    assert await drive.hosts_datasets()
    assert not await DataSource(id=str(uuid.uuid4()), name="other", provider="mem").hosts_datasets()
