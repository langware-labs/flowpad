"""Rows that live in a FILE STORE (``dataset.json`` ``location`` ``<driver>:<target>`` whose driver is
``RowFiles``: Drive, S3): the row layout as it is on disk, read and written through a working copy
under this instance (``flow_sdk.datasets.locations``). ``row.json`` is each row's commit point."""

import asyncio
import contextlib
import json
import uuid
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


@pytest.fixture
def stored(tmp_path, monkeypatch):
    """A people kind and a factory of datasets at ``mem:people`` -- each one a machine's view."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import locations
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestfiles" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.person", {"name": {"shape": "string", "description": "x"}})
    assert not any(load_root(root).values())
    store = _Ordered()

    @contextlib.asynccontextmanager
    async def opener(where):
        assert (where.driver, where.target) == ("mem", "people")
        yield store

    monkeypatch.setattr(locations, "OPENER", opener)

    async def dataset(name="people"):
        made = Dataset(id=str(uuid.uuid4()), name=name, asset_ref=str(root / "agentic-assets/dataset" / name),
                       data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.person"}]}, location="mem:people")
        await made.save()
        return made

    return SimpleNamespace(store=store, dataset=dataset, root=root)


async def _call(dataset, action, body):
    from tests.unit._graph_client import call_local

    return await call_local("POST", f"dataset/{dataset.id}/{action}", body)


async def test_the_memory_double_keeps_the_contract():
    await check_row_files(MemoryRowFiles())


async def test_a_row_written_here_lands_in_the_store_row_json_last(stored):
    people = await stored.dataset()
    done = await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert done.status_code == 200, done.text
    paths = [path for op, path in stored.store.log if op == "write"]
    assert paths[-1] == "rows/ada/row.json" and any(p.startswith("rows/ada/input/") for p in paths)
    assert not (stored.root / "agentic-assets/dataset/people/rows").exists()           # nothing in the project
    assert json.loads(stored.store.files["rows/ada/row.json"][0])["metadata"]["id"]


async def test_another_machine_reads_what_one_wrote(stored):
    here, there = await stored.dataset("here"), await stored.dataset("there")
    assert (await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})).status_code == 200
    rows = (await _call(there, "rows", {})).json()["data"]["rows"]
    assert [(r["key"], r["input"]["name"]) for r in rows] == [("ada", "Ada")]
    assert rows[0]["id"] == here.query()["rows"][0]["id"]                               # one row, one id, everywhere


async def test_a_write_over_a_row_another_machine_moved_is_refused(stored):
    here, there = await stored.dataset("here"), await stored.dataset("there")
    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await _call(there, "rows", {})
    seen = there.query()["rows"][0]["version"]
    assert (await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada L."}}})).status_code == 200
    stale = await _call(there, "put-row", {"key": "ada", "row": {"input": {"name": "Ada K."}}, "expected": seen})
    assert stale.status_code == 409, stale.text
    assert json.loads(stored.store.files["rows/ada/input/person.json"][0]) == {"name": "Ada L."} or \
        "Ada L." in stored.store.files[next(p for p in stored.store.files if p.startswith("rows/ada/input/"))][0].decode()


async def test_two_pushes_from_one_pull_one_wins(stored, monkeypatch):
    """Both working copies were up to date when they wrote; the second to push finds the row moved."""
    from flow_sdk.datasets import locations

    here, there = await stored.dataset("here"), await stored.dataset("there")
    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await there.pull()
    real_pull = locations.pull

    async def no_pull(dataset, location, root=None):        # `there` writes from what it pulled before
        return [] if dataset.id == there.id else await real_pull(dataset, location, root)

    await _call(here, "put-row", {"key": "ada", "row": {"input": {"name": "Ada L."}}})
    monkeypatch.setattr(locations, "pull", no_pull)
    lost = await _call(there, "put-row", {"key": "ada", "row": {"input": {"name": "Ada K."}}})
    monkeypatch.setattr(locations, "pull", real_pull)
    assert lost.status_code == 409, lost.text
    await there.pull()
    assert there.query()["rows"][0]["input"]["name"] == "Ada L."


async def test_a_row_without_its_row_json_is_not_read(stored):
    """An interrupted write: the slots went out, ``row.json`` did not. Nobody reads half a row."""
    people = await stored.dataset()
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    await stored.store.write_file("rows/bob/input/person.json", b'{"name": "Bob"}')
    rows = (await _call(people, "rows", {})).json()["data"]["rows"]
    assert [r["key"] for r in rows] == ["ada"]


async def test_rename_and_delete_go_out(stored):
    people = await stored.dataset()
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert (await _call(people, "rename-row", {"key": "ada", "new_key": "ada-l"})).status_code == 200
    assert {p.split("/")[1] for p in stored.store.files} == {"ada-l"}
    assert (await _call(people, "delete-row", {"key": "ada-l"})).status_code == 200
    assert stored.store.files == {} and stored.store.log[-1] == ("delete", "rows/ada-l/row.json")


async def test_a_script_reads_and_writes_the_store_itself(stored):
    """No running loop (a script): a sync call pulls first and a sync write pushes after."""
    from flow_sdk.builtin.dataset import Dataset

    people = await stored.dataset()
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    other = await stored.dataset("script")

    def script():
        ds = Dataset.at(other.asset_ref)
        keys = [r["key"] for r in ds.query()["rows"]]
        ds.delete_rows(["ada"])
        return keys

    assert await asyncio.to_thread(script) == ["ada"]
    assert stored.store.files == {}


async def test_a_sync_write_inside_the_server_is_refused_not_lost(stored):
    people = await stored.dataset()
    await _call(people, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    with pytest.raises(RuntimeError, match="row action or the async API"):
        people.delete_rows(["ada"])
    assert set(stored.store.files) and people.query()["rows"]


# ── moving the rows ──────────────────────────────────────────────────────────


async def test_rows_move_from_the_project_to_a_store_and_on_to_a_folder(stored, tmp_path):
    from flow_sdk.builtin.dataset import Dataset

    local = Dataset(id=str(uuid.uuid4()), name="moving", asset_ref=str(stored.root / "agentic-assets/dataset/moving"),
                    data_layout="io_folder", spec=(await stored.dataset("shape")).spec)
    await local.save()
    for key, name in (("ada", "Ada"), ("bob", "Bob")):
        assert (await _call(local, "put-row", {"key": key, "row": {"input": {"name": name}}})).status_code == 200
    ids = {r["key"]: r["id"] for r in local.query()["rows"]}

    moved = await _call(local, "move-rows", {"location": "mem:people"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"] == {"from": "local", "to": "mem:people", "rows": 2, "adopted": 0, "conflicts": []}
    assert {p.split("/")[1] for p in stored.store.files} == {"ada", "bob"}
    on_disk = json.loads((stored.root / "agentic-assets/dataset/moving/dataset.json").read_text())
    assert on_disk["metadata"]["location"] == "mem:people"
    rows = (await _call(local, "rows", {})).json()["data"]["rows"]
    assert {r["key"]: r["id"] for r in rows} == ids                                      # the same rows, the same ids

    folder = tmp_path / "elsewhere"
    assert (await _call(local, "move-rows", {"location": f"file:{folder}"})).json()["data"]["rows"] == 2
    assert sorted(p.name for p in (folder / "rows").iterdir()) == ["ada", "bob"]
    assert {r["key"] for r in (await _call(local, "rows", {})).json()["data"]["rows"]} == {"ada", "bob"}


async def test_rows_moved_into_a_location_that_holds_rows_adopt_them(stored):
    full = await stored.dataset("full")
    await _call(full, "put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})          # mem:people now holds a row
    from flow_sdk.builtin.dataset import Dataset

    other = Dataset(id=str(uuid.uuid4()), name="other", asset_ref=str(stored.root / "agentic-assets/dataset/other"),
                    data_layout="io_folder", spec=full.spec)
    await other.save()
    await _call(other, "put-row", {"key": "bob", "row": {"input": {"name": "Bob"}}})
    await _call(other, "put-row", {"key": "ada", "row": {"input": {"name": "Ada (mine)"}}})
    moved = await _call(other, "move-rows", {"location": "mem:people"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"] == {"from": "local", "to": "mem:people", "rows": 2, "adopted": 1, "conflicts": ["ada"]}
    rows = {r["key"]: r["input"]["name"] for r in (await _call(other, "rows", {})).json()["data"]["rows"]}
    assert rows == {"ada": "Ada", "bob": "Bob"}                                            # the copy there wins a shared key
    assert (await _call(other, "move-rows", {"location": {"driver": "crm", "map": {"key": "k", "input": {"k": "k"}}}})).status_code == 400


# ── the gate ─────────────────────────────────────────────────────────────────


def test_a_project_that_tracks_rows_is_named_by_the_gate(tmp_path):
    import subprocess

    from flow_sdk.datasets.locations import tracked_rows

    project = tmp_path / "proj"
    rows = project / "agentic-assets/dataset/leads/rows/ada"
    rows.mkdir(parents=True)
    (rows / "row.json").write_text("{}")
    (project / "agentic-assets/dataset/leads/dataset.json").write_text("{}")
    git = lambda *a: subprocess.run(["git", *a], cwd=project, check=True, capture_output=True)  # noqa: E731
    git("init", "-q")
    assert tracked_rows(project) == []                                                # nothing tracked yet
    git("add", "agentic-assets/dataset/leads/dataset.json")
    assert tracked_rows(project) == []                                                # the shape is fine
    git("add", "-f", "agentic-assets/dataset/leads/rows/ada/row.json")
    assert tracked_rows(project) == ["agentic-assets/dataset/leads/rows/ada/row.json"]
    assert tracked_rows(tmp_path / "not-a-repo") == []
