"""The DECLARED mirror: a data source names a dataset of its project (``mirror`` in its
``data_source.json``), and after every sync that dataset is made the mirror of its records
(``flow_sdk.datasets.projection``) -- nobody has to call ``Dataset.mirror``."""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest

from tests.unit.test_data_spec.test_row_links import _dataset, _schema

pytestmark = pytest.mark.timeout(5)

ITEMS = [
    {"id": "i1", "external_id": "T-1", "name": "Call Acme back", "provider": "crm", "data": {"status": "TODO"}},
    {"id": "i2", "external_id": "T-2", "name": "Write the plan", "provider": "crm", "data": {"status": "DONE"}},
]
MAP = {"key": "external_id", "input": {"title": "name", "status": "data.status", "crm_id": "external_id"}}


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project with a tasks dataset and a source that mirrors into it; the store answers ``ITEMS``."""
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestdecl" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}  # noqa: E731
    _schema(root, ns, "crm.task", {"title": f("string", owned_by="crm"), "status": f("string", owned_by="crm"),
                                   "crm_id": f("string", owned_by="crm"), "notes": f("?string")})
    assert not any(load_root(root).values())
    tasks = _dataset(root, "tasks", f"--{ns}--.crm.task")
    folder = root / "agentic-assets/data_source/crm-tasks"
    folder.mkdir(parents=True)
    source = DataSource(id=str(uuid.uuid4()), provider="crm", account_key="a", name="CRM tasks", asset_ref=str(folder),
                        mirror={"dataset": "tasks", "map": MAP})
    store = {"items": list(ITEMS)}

    async def get_all(match, *a, **k):
        assert match == {"data_source_id": str(source.id)}
        return [SimpleNamespace(model_dump=lambda mode="json", item=item: item) for item in store["items"]]

    async def get_by_id(source_id, *a, **k):
        return source if source_id == source.id else None

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    monkeypatch.setattr(DataSource, "get_by_id", get_by_id)
    return source, tasks, store


def _rows(tasks) -> dict:
    return {row["key"]: {k: v for k, v in row["input"].items() if v is not None} for row in tasks.rows()["rows"]}


# ── the declaration ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("mirror, says", [
    ({"dataset": "", "map": MAP}, "mirror.dataset"),
    ({"dataset": "../x", "map": MAP}, "mirror.dataset"),
    ({"dataset": "tasks", "map": {"key": "external_id"}}, "mirror.map"),
    ({"dataset": "tasks", "map": {"key": "external_id", "input": {"title": "name"}}}, "map the key path 'external_id' to a field"),
    ({"dataset": "tasks", "map": MAP, "into": "x"}, "mirror:"),
])
def test_a_mirror_is_checked_where_it_is_declared(mirror, says):
    from pydantic import ValidationError

    from flow_sdk.builtin.data_source import DataSource

    with pytest.raises(ValidationError, match=says):
        DataSource(provider="crm", name="x", mirror=mirror)
    assert DataSource(provider="crm", name="x", mirror={}).mirror is None


def test_the_mirror_is_part_of_the_source_file():
    from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec

    read = DataSourceSpec.model_validate({"data_driver_name": "crm", "mirror": {"dataset": "tasks", "map": MAP}})
    assert read.mirror == {"dataset": "tasks", "map": MAP}


async def test_a_source_naming_a_dataset_its_project_lacks_is_refused_by_name(project):
    from flow_sdk.datasets.projection import project_source

    source, _, _ = project
    source.mirror = {"dataset": "ghosts", "map": MAP}
    with pytest.raises(LookupError, match="mirrors into 'ghosts', which its project does not hold"):
        await project_source(source)
    source.mirror = None
    assert await project_source(source) is None


# ── after every sync ─────────────────────────────────────────────────────────


async def test_each_sync_makes_the_dataset_the_mirror_of_the_records(project):
    from flow_sdk.datasets.projection import _on_sync

    source, tasks, store = project
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert _rows(tasks) == {"t-1": {"title": "Call Acme back", "status": "TODO", "crm_id": "T-1"},
                            "t-2": {"title": "Write the plan", "status": "DONE", "crm_id": "T-2"}}

    await tasks.put("t-1", {"input": {**_rows(tasks)["t-1"], "notes": "ours"}})     # a field the app keeps
    store["items"] = [{**ITEMS[0], "data": {"status": "DONE"}}]                       # T-2 is gone; T-1 is done
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert _rows(tasks) == {"t-1": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "notes": "ours"}}


async def test_a_sync_during_a_sweep_buys_one_more_round_not_a_pile(project, monkeypatch):
    from flow_sdk.datasets import projection

    source, _, _ = project
    ran, gate = [], asyncio.Event()

    async def slow(source_id):
        ran.append(source_id)
        await gate.wait()

    monkeypatch.setattr(projection, "_project", slow)
    event = SimpleNamespace(data={"source_id": source.id})
    first = asyncio.create_task(projection._on_sync(event))
    await asyncio.sleep(0)
    await asyncio.gather(*(projection._on_sync(event) for _ in range(3)))      # three syncs land mid-sweep
    gate.set()
    await first
    assert ran == [source.id, source.id]


async def test_a_broken_mirror_is_logged_and_the_next_sync_tries_again(project, caplog):
    from flow_sdk.datasets.projection import _on_sync

    source, tasks, _ = project
    source.mirror = {"dataset": "ghosts", "map": MAP}
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert "projecting source" in caplog.text and _rows(tasks) == {}
