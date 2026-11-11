"""Where a dataset's rows live (``flow_sdk.datasets.stores``): dataset → data source → data store.

No ``data_source``: the project's data store -- this instance's folder, out of the project and out of git,
named by the project's ``ns`` and the dataset's folder. A ``data_source`` of an object-store driver
(``RowFiles``: Drive, S3, the Flowpad hub) holds the row layout as it is on disk, read and written through
a working copy under this instance; ``row.json`` is each row's commit point. A source that is not set up
holds nothing: its datasets refuse until it is.
"""

import asyncio
import contextlib
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.sources.testing import MemoryRowFiles, check_row_files
from tests.unit.test_data_spec.test_row_links import _schema

pytestmark = pytest.mark.timeout(5)


class _Ordered(MemoryRowFiles):
    """The double, recording the order of writes and deletes."""

    def __init__(self):
        super().__init__()
        self.log: list[tuple[str, str]] = []

    async def write_file(self, path, data, *, expected=None):
        version = await super().write_file(path, data, expected=expected)
        self.log.append(("write", path))
        return version

    async def delete_file(self, path, *, expected=None):
        await super().delete_file(path, expected=expected)
        self.log.append(("delete", path))


class _MemDriver:
    """An object-store driver: rows in a folder of the source."""

    @classmethod
    def rows_within(cls, config, path):
        return {**config, "path": "/".join(p for p in (config.get("path", ""), path) if p)}


def _source(root: Path, name: str, driver: str = "mem", config: dict | None = None) -> None:
    folder = root / "agentic-assets" / "data_source" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "data_source.json").write_text(json.dumps(   # flat, as DataSourceSpec writes it
        {"type": "data_source", "name": name, "data_driver_name": driver, "data_driver_config": config or {"path": "GTM"}}))


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A people kind, a ``drive`` data source over an in-memory store, and a factory of datasets -- two of
    them on one folder of the store are two machines' views."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import stores
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestfiles" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.person", {"name": {"shape": "string", "description": "x"}})
    assert not any(load_root(root).values())
    _source(root, "drive")
    store, seen, refusal = _Ordered(), [], {"why": ""}

    @contextlib.asynccontextmanager
    async def opener(where):
        seen.append(where)
        yield store

    async def refused(name, project_id=""):
        return refusal["why"]

    real = stores._driver_class
    monkeypatch.setattr(stores, "_driver_class", lambda provider, folder="": _MemDriver if provider == "mem" else real(provider, folder))
    monkeypatch.setattr(stores, "OPENER", opener)
    monkeypatch.setattr(stores, "source_refusal", refused)
    stores._checked.clear()

    async def dataset(name="people", **fields):
        made = Dataset(id=str(uuid.uuid4()), name=name, asset_ref=str(root / "agentic-assets/dataset" / name),
                       data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.person"}]}, **fields)
        Path(made.asset_ref).mkdir(parents=True, exist_ok=True)
        await made.save()
        return made

    async def machine(name):
        """A dataset on the store's ``people`` folder."""
        return await dataset(name, data_source="drive", path="people")

    return SimpleNamespace(root=root, ns=ns, store=store, seen=seen, refusal=refusal, dataset=dataset, machine=machine)


async def _call(dataset, action, body):
    from tests.unit._graph_client import call_local

    return await call_local("POST", f"dataset/{dataset.id}/{action}", body)


async def test_the_memory_double_keeps_the_contract():
    await check_row_files(MemoryRowFiles())


# ── where the rows are ───────────────────────────────────────────────────────


def test_a_source_resolves_to_its_driver_config_and_the_dataset_folder(project):
    from flow_sdk.datasets.stores import FILES, FOLDER, resolve

    folder = project.root / "agentic-assets" / "dataset" / "gtm-personas"
    where = resolve(folder, "drive")
    assert (where.kind, where.driver, where.config, where.source, where.path) == (FILES, "mem", {"path": "GTM/gtm-personas"}, "drive", "gtm-personas")
    assert where.label() == "drive · gtm-personas"
    assert resolve(folder, "drive", "shared/people").path == "shared/people"
    held = resolve(folder, None)
    assert held.kind == FOLDER and held.label() == "project data store"
    with pytest.raises(ValueError, match="no data source 'nope'"):
        resolve(folder, "nope")


async def test_rows_without_a_source_are_in_the_project_data_store_out_of_the_project(project):
    from flow_sdk.instance_settings import get_instance_settings

    (project.root / "agentic-assets/project_manifest").mkdir(parents=True)
    (project.root / "agentic-assets/project_manifest/project_manifest.json").write_text(json.dumps({"ns": project.ns}))
    people = await project.dataset()
    assert (await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})).status_code == 200
    held = get_instance_settings().instance_dir / "data_stores" / project.ns / "people" / "rows" / "ada" / "row.json"
    assert held.is_file() and not list(Path(people.asset_ref).rglob("row.json"))
    from flow_sdk.builtin.dataset import Dataset

    again = Dataset(id=str(uuid.uuid4()), name="people", asset_ref=people.asset_ref, data_layout="io_folder",
                    spec=people.spec)      # a new id for the same folder (a fresh clone, a rebuilt .flow)
    assert [r["key"] for r in again.query()["rows"]] == ["ada"]


async def test_the_project_names_its_data_store(project):
    (project.root / "flow.json").write_text(json.dumps({"data_store": "drive"}))
    people = await project.dataset()
    assert (await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})).status_code == 200
    assert {p.split("/")[1] for p in project.store.files} == {"ada"}
    assert (project.seen[-1].source, project.seen[-1].path) == ("drive", "people")


# ── a source that is not set up holds nothing ────────────────────────────────


async def test_a_source_that_is_not_set_up_refuses_until_it_is(project):
    project.refusal["why"] = "drive needs setup: not verified"
    people = await project.dataset(data_source="drive")
    put = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 503 and "needs setup" in put.text
    assert not project.store.files and not project.seen and not list(Path(people.asset_ref).rglob("row.json"))
    project.refusal["why"] = ""
    from flow_sdk.datasets import stores

    stores._checked.clear()                    # the source's verify answers again (refresh_hosted)
    put = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 200, put.text
    assert {p.split("/")[1] for p in project.store.files} == {"ada"} and people.rows_at == "drive · people"


# ── an object store ──────────────────────────────────────────────────────────


async def test_a_row_written_here_lands_in_the_store_row_json_last(project):
    people = await project.machine("here")
    done = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert done.status_code == 200, done.text
    paths = [path for op, path in project.store.log if op == "write"]
    assert paths[-1] == "rows/ada/row.json" and any(p.startswith("rows/ada/input/") for p in paths)
    assert not list(Path(people.asset_ref).rglob("row.json"))                           # nothing in the project
    assert json.loads(project.store.files["rows/ada/row.json"][0])["metadata"]["id"]


async def test_another_machine_reads_what_one_wrote(project):
    here, there = await project.machine("here"), await project.machine("there")
    assert (await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})).status_code == 200
    rows = (await _call(there, "rows", {})).json()["data"]["rows"]
    assert [(r["key"], r["input"]["name"]) for r in rows] == [("ada", "Ada")]
    assert rows[0]["id"] == here.query()["rows"][0]["id"]                               # one row, one id, everywhere


async def test_a_write_over_a_row_another_machine_moved_is_refused(project):
    here, there = await project.machine("here"), await project.machine("there")
    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await _call(there, "rows", {})
    seen = there.query()["rows"][0]["version"]
    assert (await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada L."}}})).status_code == 200
    stale = await _call(there, "put-row", {"key": "ada", "row": {"input": {"name": "Ada K."}}, "expected": seen})
    assert stale.status_code == 409, stale.text
    held = project.store.files[next(p for p in project.store.files if p.startswith("rows/ada/input/"))][0].decode()
    assert "Ada L." in held


async def test_two_pushes_from_one_pull_one_wins(project, monkeypatch):
    """Both working copies were up to date when they wrote; the second to push finds the row moved."""
    from flow_sdk.datasets import stores

    here, there = await project.machine("here"), await project.machine("there")
    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await there.pull()
    real_pull = stores.pull

    async def no_pull(dataset, store, root=None):        # `there` writes from what it pulled before
        return {"moved": [], "gone": []} if dataset.id == there.id else await real_pull(dataset, store, root)

    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada L."}}})
    monkeypatch.setattr(stores, "pull", no_pull)
    lost = await _call(there, "put-row", {"key": "ada", "row": {"input": {"name": "Ada K."}}})
    monkeypatch.setattr(stores, "pull", real_pull)
    assert lost.status_code == 409, lost.text
    await there.pull()
    assert there.query()["rows"][0]["input"]["name"] == "Ada L."


async def test_a_row_without_its_row_json_is_not_read(project):
    """An interrupted write: the slots went out, ``row.json`` did not. Nobody reads half a row."""
    people = await project.machine("here")
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await project.store.write_file("rows/bob/input/person.json", b'{"name": "Bob"}')
    rows = (await _call(people, "rows", {})).json()["data"]["rows"]
    assert [r["key"] for r in rows] == ["ada"]


async def test_rename_and_delete_go_out(project):
    people = await project.machine("here")
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert (await _call(people, "rename-row", {"key": "ada", "new_key": "ada-l"})).status_code == 200
    assert {p.split("/")[1] for p in project.store.files} == {"ada-l"}
    assert (await _call(people, "delete-row", {"key": "ada-l"})).status_code == 200
    assert project.store.files == {} and project.store.log[-1] == ("delete", "rows/ada-l/row.json")


async def test_a_script_reads_and_writes_the_store_itself(project):
    """No running loop (a script): a sync call pulls first and a sync write pushes after."""
    from flow_sdk.builtin.dataset import Dataset

    people = await project.machine("here")
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    other = await project.machine("script")

    def script():
        ds = Dataset.at(other.asset_ref)
        keys = [r["key"] for r in ds.query()["rows"]]
        ds.delete_rows(["ada"])
        return keys

    assert await asyncio.to_thread(script) == ["ada"]
    assert project.store.files == {}


async def test_a_sync_write_inside_the_server_is_refused_not_lost(project):
    people = await project.machine("here")
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    with pytest.raises(RuntimeError, match="row action or the async API"):
        people.delete_rows(["ada"])
    assert set(project.store.files) and people.query()["rows"]


async def test_a_new_dataset_on_a_folder_with_rows_reads_them(project):
    first = await project.dataset("first", data_source="drive", path="shared")
    await _call(first, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    second = await project.dataset("second", data_source="drive", path="shared")
    assert [r["key"] for r in (await _call(second, "rows", {})).json()["data"]["rows"]] == ["ada"]


# ── moving the rows ──────────────────────────────────────────────────────────


async def test_rows_move_from_the_project_data_store_into_a_source_and_back(project):
    people = await project.dataset()
    for key, name in (("ada", "Ada"), ("bob", "Bob")):
        assert (await _call(people, "put-row", {"key": key, "row": {"input": {"name": name}}})).status_code == 200
    ids = {r["key"]: r["id"] for r in people.query()["rows"]}

    project.refusal["why"] = "drive needs setup: not verified"
    refused = await _call(people, "move-rows", {"data_source": "drive"})
    assert refused.status_code == 503 and "needs setup" in refused.text                  # not set up: nothing moves
    project.refusal["why"] = ""
    from flow_sdk.datasets import stores

    stores._checked.clear()
    moved = await _call(people, "move-rows", {"data_source": "drive"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"] == {"from": "project data store", "to": "drive · people", "rows": 2}
    assert {p.split("/")[1] for p in project.store.files} == {"ada", "bob"}
    metadata = json.loads((Path(people.asset_ref) / "dataset.json").read_text())["metadata"]
    assert metadata.get("data_source") == "drive"
    assert {r["key"]: r["id"] for r in (await _call(people, "rows", {})).json()["data"]["rows"]} == ids   # same rows, same ids

    back = await _call(people, "move-rows", {})
    assert back.status_code == 200 and back.json()["data"]["to"] == "project data store"
    assert "data_source" not in json.loads((Path(people.asset_ref) / "dataset.json").read_text())["metadata"]
    assert {r["key"] for r in (await _call(people, "rows", {})).json()["data"]["rows"]} == {"ada", "bob"}


async def test_rows_moved_where_rows_already_are_keep_the_ones_there(project):
    full = await project.machine("full")
    await _call(full, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})          # drive · people holds a row
    other = await project.dataset("other")
    await _call(other, "put-row", {"key": "bob", "row": {"input": {"name": "Bob"}}})
    await _call(other, "put-row", {"key": "ada", "row": {"input": {"name": "Ada (mine)"}}})
    moved = await _call(other, "move-rows", {"data_source": "drive", "path": "people"})
    assert moved.status_code == 200, moved.text
    rows = {r["key"]: r["input"]["name"] for r in (await _call(other, "rows", {})).json()["data"]["rows"]}
    assert rows == {"ada": "Ada", "bob": "Bob"}                                            # the copy there stays
    assert (await _call(other, "move-rows", {"location": "mem:people"})).status_code == 400


# ── a source and the datasets it hosts ───────────────────────────────────────


async def test_a_source_knows_the_datasets_it_hosts(project):
    from flow_sdk.builtin.data_source import DataSource

    name = "drive" + uuid.uuid4().hex[:8]   # the index is shared across tests: a name of its own
    _source(project.root, name)
    await project.dataset("a", data_source=name)
    await project.dataset("b", data_source=name)
    await project.dataset("c")
    drive = DataSource(id=str(uuid.uuid4()), name=name, provider="mem")
    assert sorted(d.name for d in await drive.datasets()) == ["a", "b"]
    assert not await DataSource(id=str(uuid.uuid4()), name="other", provider="mem").datasets()


async def test_a_source_that_turns_ready_fills_each_working_copy_once(project):
    """Links read another dataset's rows from disk: a hosted dataset never opened is pulled when its source is ready."""
    from flow_sdk.datasets import stores

    writer = await project.dataset("writer", data_source="drive", path="shared")
    await _call(writer, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    reader = await project.dataset("reader", data_source="drive", path="shared")    # never opened
    assert not (stores.rows_folder(reader, reader._rows_store()) / stores.STATE_FILE).exists()

    source = SimpleNamespace(name="drive", project_id="", datasets=None)
    await stores.refresh_hosted(source, [reader])
    await asyncio.gather(*stores._filling)        # the first pull runs behind the check

    root = stores.rows_folder(reader, reader._rows_store())
    assert (root / stores.STATE_FILE).is_file() and (root / "rows" / "ada" / "row.json").is_file()


async def test_at_startup_each_hosting_source_answers_once(project):
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.datasets import stores

    name = "drive" + uuid.uuid4().hex[:8]
    _source(project.root, name)
    await project.dataset("people", data_source=name)
    await DataSource(id=str(uuid.uuid4()), name=name, provider="mem").save()
    stores._checked.clear()
    await stores.refresh_all_hosted()
    await asyncio.gather(*stores._filling)
    assert stores._checked.get(name) == ""


def test_a_projects_own_driver_is_loaded_to_place_its_datasets(tmp_path):
    """A process that has not loaded the project's drivers (the indexer, a script) still places a dataset
    whose data source runs one of them: the driver is loaded from the project's ``data_driver/``."""
    from flow_sdk.datasets.stores import RECORDS, resolve

    root, name = tmp_path / "proj", "crm" + uuid.uuid4().hex[:8]
    driver = root / "agentic-assets" / "data_driver" / name
    driver.mkdir(parents=True)
    (driver / "data_driver.json").write_text(json.dumps({"schema": 1, "name": name, "title": "CRM", "kind": f"datasource.{name}", "ns": "acme"}))
    (driver / "source.py").write_text(f'from flow_sdk.sources.families import RecordSource\n\n\nclass CrmSource(RecordSource):\n    provider = "{name}"\n')
    _source(root, "deals", driver=name, config={})
    where = resolve(root / "agentic-assets" / "dataset" / "deals", "deals")
    assert (where.kind, where.driver, where.holder.label()) == (RECORDS, name, "project data store")
