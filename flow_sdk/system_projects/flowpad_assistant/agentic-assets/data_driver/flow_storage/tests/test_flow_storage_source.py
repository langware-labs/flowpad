"""``flow_storage``: a dataset's rows in a hub data store.

The hub is stood in for by an in-memory ``data_store`` that keeps the hub's contract -- versions, a write
conditioned on the version last read refused with 409, 404 for a missing file -- behind the two hub client
calls the driver makes. The hub side of the contract has its own tests (hub ``test_data_store.py``).
"""
from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.sources.binding import SourceBinding


class FakeHub:
    """The hub's data_store actions, in memory."""

    def __init__(self):
        self.stores: dict[str, dict[str, tuple[bytes, int]]] = {}
        self.tick = 0

    async def call(self, method, entity_type, entity_id=None, action=None, sub_path=None, *, payload=None, **kw):
        """``HubProxy.call``: GETs to ``get``, POSTs to ``post``."""
        if method == "GET":
            return await self.get(entity_type, entity_id, action, sub_path, scope=kw.get("scope"), params=kw.get("params"))
        assert method == "POST", method
        return await self.post(entity_type, payload, entity_id, action, sub_path)

    async def get(self, entity_type, entity_id=None, action=None, sub_path=None, *, scope=None, params=None):
        files = self.stores.get(entity_id)
        if entity_type != "data_store" or files is None:
            raise HubError(404, "no such store")
        if action == "files":
            prefix = (params or {}).get("prefix", "")
            return {"files": {p: str(v) for p, (_, v) in files.items() if not prefix or p.startswith(prefix + "/")}}
        if action == "read":
            path = params["path"]
            if path not in files:
                raise HubError(404, f"no file {path}")
            data, version = files[path]
            return {"path": path, "version": str(version), "data": base64.b64encode(data).decode()}
        raise HubError(400, action)

    async def post(self, entity_type, payload, entity_id=None, action=None, sub_path=None, **_):
        if entity_id is None:                                   # create
            store_id = str(uuid.uuid4())
            self.stores[store_id] = {}
            return {"id": store_id, "name": payload.get("name")}
        files = self.stores.get(entity_id)
        if files is None:
            raise HubError(404, "no such store")
        path = payload["path"]
        now = str(files[path][1]) if path in files else ""
        if "expected" in payload and payload["expected"] != now:
            raise HubError(409, "changed")
        if action == "write":
            self.tick += 1
            files[path] = (base64.b64decode(payload["data"]), self.tick)
            return {"path": path, "version": str(self.tick)}
        if action == "delete":
            files.pop(path, None)
            return {}
        raise HubError(400, action)


@pytest.fixture
async def driver():
    return await DataDriver.find("flow_storage")


@pytest.fixture
def hub(monkeypatch, driver):
    fake = FakeHub()
    monkeypatch.setattr(HubProxy, "call", staticmethod(fake.call))
    return fake


def _source(driver, config):
    return driver.cls(SourceBinding(source_id="s", name="gtm", config=config))


async def test_a_hub_store_keeps_the_row_files_contract(driver, hub):
    from flow_sdk.sources.testing.row_files import check_row_files

    store_id = (await hub.post("data_store", {"name": "t"}))["id"]
    async with _source(driver, {"store_id": store_id, "prefix": "gtm-personas"}) as source:
        await check_row_files(source)


async def test_a_write_over_a_newer_version_is_a_conflict(driver, hub):
    from flow_sdk.sources.errors import Conflict

    store_id = (await hub.post("data_store", {"name": "t"}))["id"]
    async with _source(driver, {"store_id": store_id}) as source:
        first = await source.write_file("rows/a/row.json", b"1", expected="")
        await source.write_file("rows/a/row.json", b"2", expected=first)
        with pytest.raises(Conflict):
            await source.write_file("rows/a/row.json", b"3", expected=first)


async def test_setup_makes_the_store_once_and_checks_it(driver, hub):
    source = _source(driver, {})
    assert "no data store" in (await source.verify()).detail
    made = await source._create(check=False, values={})
    store_id = made.value.config["store_id"]
    assert store_id in hub.stores
    kept = _source(driver, {"store_id": store_id})
    assert (await kept._create(check=True, values={})).ok
    assert (await kept.verify()).ready is True
    assert driver.holds_rows and driver.cls.rows_within({"store_id": store_id}, "people")["prefix"] == "people"


async def test_a_dataset_in_a_hub_store_round_trips_its_rows(tmp_path, monkeypatch, hub):
    """dataset → data source (flow_storage, store_id) → the hub store: a row written here is a file there."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import stores
    from flow_sdk.schema.data_spec.declared import load_root
    from tests.unit._graph_client import call_local
    from tests.unit.test_data_spec.test_row_links import _schema

    root, ns = tmp_path / "proj", "unittesthub" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.person", {"name": {"shape": "string", "description": "x"}})
    assert not any(load_root(root).values())
    store_id = (await hub.post("data_store", {"name": "proj"}))["id"]
    folder = root / "agentic-assets" / "data_source" / "store"
    folder.mkdir(parents=True)
    (folder / "data_source.json").write_text(json.dumps({"type": "data_source", "name": "store", "data_driver_name": "flow_storage",
                                                         "data_driver_config": {"store_id": store_id}}))

    async def ready(name, project_id=""):
        return ""

    monkeypatch.setattr(stores, "source_refusal", ready)
    stores._checked.clear()
    people = Dataset(id=str(uuid.uuid4()), name="people", asset_ref=str(root / "agentic-assets/dataset/people"),
                     data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.person"}]}, data_source="store")
    Path(people.asset_ref).mkdir(parents=True)
    await people.save()

    put = await call_local("POST", f"dataset/{people.id}/put-row", {"key": "ada", "row": {"input": {"name": "Ada"}}})
    assert put.status_code == 200, put.text
    assert "people/rows/ada/row.json" in hub.stores[store_id]                      # on the hub, under the dataset
    rows = (await call_local("POST", f"dataset/{people.id}/rows", {})).json()["data"]["rows"]
    assert [r["key"] for r in rows] == ["ada"]
    assert people._rows_store().kind == "files" and people.rows_at == "store · people"
