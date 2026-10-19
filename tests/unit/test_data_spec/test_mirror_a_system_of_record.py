"""A system of record through a data source: its items become typed rows (``Dataset.mirror``), and a
field the app owns goes back through the source's driver (``DataSource.update_item`` / ``delete_item``)
-- with the credential the source holds, never the app."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from flow_sdk.sources.values.items import RecordData, RecordItem, SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin
from tests.unit.test_data_spec.test_row_links import _dataset, _schema

pytestmark = pytest.mark.timeout(5)

ITEMS = [
    {"id": "i1", "external_id": "OPP-1", "name": "Acme renewal", "provider": "crm", "data": {"stage": "open", "amount": 12, "owner": {"name": "Heidi"}}},
    {"id": "i2", "external_id": "OPP-2", "name": "Bolt pilot", "provider": "crm", "data": {"stage": "won", "amount": 30}},
    {"id": "i3", "external_id": "", "name": "no id yet", "provider": "crm", "data": {"stage": "open"}},
]
MAP = {"key": "external_id", "input": {"name": "name", "stage": "data.stage", "crm_id": "external_id", "owner": "data.owner.name", "source": {"value": "crm"}}}


@pytest.fixture
def deals(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestmir" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}   # noqa: E731
    _schema(root, ns, "crm.deal", {"name": f("string", owned_by="crm"), "stage": f("enum:open|won|lost", owned_by="crm"),
                                   "crm_id": f("string", owned_by="crm"), "owner": f("?string", owned_by="crm"),
                                   "source": f("?string"), "notes": f("?string")})
    assert not any(load_root(root).values())
    return _dataset(root, "deals", f"--{ns}--.crm.deal")


async def test_a_sources_items_become_typed_rows(deals):
    done = await deals.mirror(ITEMS, MAP, by="crm")
    assert done == {"created": ["opp-1", "opp-2"], "updated": [], "unchanged": [], "deleted": []}     # the item with no key is skipped
    rows = {r.key: r.input.model_dump(mode="json", exclude_none=True) for r in deals.read_rows()}
    assert rows["opp-1"] == {"name": "Acme renewal", "stage": "open", "crm_id": "OPP-1", "owner": "Heidi", "source": "crm"}
    assert rows["opp-2"] == {"name": "Bolt pilot", "stage": "won", "crm_id": "OPP-2", "source": "crm"}   # an absent path is left out


async def test_mirroring_again_is_a_sync_and_keeps_what_the_app_owns(deals):
    await deals.mirror(ITEMS, MAP, by="crm")
    await deals.put("opp-1", {"input": {**deals.row("opp-1")["input"], "notes": "call back Tuesday"}})   # the app's own field
    moved = [dict(ITEMS[0], data={"stage": "won", "amount": 12, "owner": {"name": "Heidi"}})]                # the CRM moved one, dropped the other
    done = await deals.mirror(moved, MAP, by="crm")
    assert done == {"created": [], "updated": ["opp-1"], "unchanged": [], "deleted": ["opp-2"]}
    row = deals.row("opp-1")["input"]
    assert (row["stage"], row["notes"]) == ("won", "call back Tuesday")                      # the mirror owns only what it maps
    assert (await deals.mirror(moved, MAP, by="crm"))["unchanged"] == ["opp-1"]              # ... and keeping it is not a change
    gone = [dict(moved[0], data={"stage": "won", "amount": 12})]                             # the CRM cleared the owner
    await deals.mirror(gone, MAP, by="crm")
    assert "owner" not in {k: v for k, v in deals.row("opp-1")["input"].items() if v is not None}   # a mapped field follows the source
    assert (await deals.mirror(moved, MAP, by="crm", prune=False))["deleted"] == []


async def test_a_mirror_refuses_what_is_the_callers_mistake(deals):
    from flow_sdk.builtin.dataset import LinkError

    with pytest.raises(LinkError) as refused:                                  # without `by`: the CRM's fields are not ours to set
        await deals.mirror(ITEMS, MAP)
    assert {d["code"] for d in refused.value.details} == {"owned"} and deals.read_rows() == []
    with pytest.raises(ValueError, match="two items map to the row key 'opp-1'"):
        await deals.mirror([ITEMS[0], dict(ITEMS[0], external_id="opp 1")], MAP, by="crm")
    for wrong in ({}, {"key": "external_id"}, {"key": 3, "input": {}}):
        with pytest.raises(ValueError, match="map:"):
            await deals.mirror(ITEMS, wrong, by="crm")


BAD = [dict(ITEMS[0]), dict(ITEMS[1], data={"stage": "maybe"})]          # the CRM holds a stage the schema does not allow


async def test_a_mirror_keeps_the_rows_that_fit_and_names_the_misfits(deals):
    """The outside system's value is not ours to fix: the record is kept as a problem row, with its
    input intact, and every other record is still mirrored."""
    done = await deals.mirror(BAD, MAP, by="crm")
    assert done["created"] == ["opp-1"] and [m["key"] for m in done["misfit"]] == ["opp-2"]
    assert done["misfit"][0]["details"][0]["path"] == "input.stage"
    rows, problems = deals.rows_and_problems()
    assert [r.key for r in rows] == ["opp-1"]
    assert [(p["key"], p["input"]["stage"], p["input"]["name"]) for p in problems] == [("opp-2", "maybe", "Bolt pilot")]


async def test_a_misfit_still_listed_is_not_pruned_and_one_gone_is(deals):
    await deals.mirror(BAD, MAP, by="crm")
    again = await deals.mirror(BAD, MAP, by="crm")
    assert again["deleted"] == [] and [m["key"] for m in again["misfit"]] == ["opp-2"]
    gone = await deals.mirror(BAD[:1], MAP, by="crm")
    assert gone["deleted"] == ["opp-2"] and "misfit" not in gone and deals.rows_and_problems()[1] == []


async def test_a_misfit_that_fits_again_becomes_a_row_and_keeps_its_id(deals):
    await deals.mirror(BAD, MAP, by="crm")
    before = deals.rows_and_problems()[1][0]["id"]
    done = await deals.mirror(ITEMS, MAP, by="crm")
    assert done["updated"] == ["opp-2"] and "misfit" not in done
    row = next(r for r in deals.read_rows() if r.key == "opp-2")
    assert row.id == before and row.input.stage == "won"


async def test_a_row_that_stops_fitting_keeps_what_the_app_owns(deals):
    await deals.mirror(ITEMS, MAP, by="crm")
    await deals.put("opp-2", {"input": {**deals.row("opp-2")["input"], "notes": "ours"}})
    await deals.mirror(BAD, MAP, by="crm")
    problem = deals.rows_and_problems()[1][0]
    assert (problem["key"], problem["input"]["notes"], problem["input"]["stage"]) == ("opp-2", "ours", "maybe")


async def test_a_row_is_found_by_its_natural_key_not_its_row_key(deals):
    """A row made before the mirror, keyed as its author liked, holds the record's id in the mapped key
    field: the mirror adopts it -- same key, same id, every link to it kept -- instead of minting a twin."""
    await deals.put("acme-renewal", {"input": {"name": "Acme (old name)", "stage": "open", "crm_id": "OPP-1", "notes": "ours"}}, by="crm")
    before = deals.row("acme-renewal")["id"]
    done = await deals.mirror(ITEMS, MAP, by="crm")
    assert done["updated"] == ["acme-renewal"] and done["created"] == ["opp-2"] and done["deleted"] == []
    row = deals.row("acme-renewal")
    assert row["id"] == before and (row["input"]["name"], row["input"]["notes"]) == ("Acme renewal", "ours")
    assert (await deals.mirror(ITEMS, MAP, by="crm"))["unchanged"] == ["acme-renewal", "opp-2"]


async def test_a_required_list_the_map_does_not_name_starts_empty_on_a_mirrored_row(tmp_path):
    """The app's own required list (a deal's objections) is not the CRM's to fill: a row the mirror
    makes gets `[]`, so the record fits -- and what the app later puts in it is kept."""
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestreq" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}   # noqa: E731
    _schema(root, ns, "crm.deal", {"name": f("string", owned_by="crm"), "crm_id": f("string", owned_by="crm"),
                                   "objections": f(["string"]), "dates": f({"won": "?string"}), "notes": f("?string")})
    assert not any(load_root(root).values())
    deals = _dataset(root, "deals", f"--{ns}--.crm.deal")
    small = {"key": "external_id", "input": {"name": "name", "crm_id": "external_id"}}
    done = await deals.mirror(ITEMS, small, by="crm")
    assert done["created"] == ["opp-1", "opp-2"] and "misfit" not in done
    made = deals.row("opp-1")["input"]
    assert made["objections"] == [] and not any((made["dates"] or {}).values())     # the map, empty, in its full shape
    await deals.put("opp-1", {"input": {**deals.row("opp-1")["input"], "objections": ["price"]}})
    assert (await deals.mirror(ITEMS, small, by="crm"))["unchanged"] == ["opp-1", "opp-2"]
    assert deals.row("opp-1")["input"]["objections"] == ["price"]


async def test_sync_stays_all_or_nothing(deals):
    """Only a mirror is lenient: an app's batch write still fits whole or writes nothing."""
    from flow_sdk.builtin.dataset import LinkError

    rows = [{"key": "a", "input": {"name": "A", "stage": "open", "crm_id": "A"}},
            {"key": "b", "input": {"name": "B", "stage": "maybe", "crm_id": "B"}}]
    with pytest.raises(LinkError, match="b.input.stage"):
        await deals.sync(rows, by="crm")
    assert deals.read_rows() == [] and deals.rows_and_problems()[1] == []


async def test_in_the_server_a_data_source_is_mirrored_as_its_provider(deals, monkeypatch):
    from flow_sdk.builtin.source_item import SourceItem

    asked = []

    async def get_all(match, *a, **k):
        asked.append(match)
        return [SimpleNamespace(model_dump=lambda mode="json", item=item: item) for item in ITEMS[:2]]

    monkeypatch.setattr(SourceItem, "get_all", get_all)
    done = await deals.mirror(SimpleNamespace(id="src-1", provider="crm"), MAP)   # `by` defaults to the source's provider
    assert asked == [{"data_source_id": "src-1"}] and done["created"] == ["opp-1", "opp-2"]


# ── write back through the driver ────────────────────────────────────────────


class _Crm:
    """A driver that can write (``sources.protocols.Mutable``)."""

    def __init__(self):
        self.calls = []

    async def create(self, data):
        self.calls.append(("create", data.title))
        return RecordItem(origin=CloudOrigin(kind="record", namespace="crm.example", key="OPP-9"), data=data)

    async def update(self, origin, changes):
        self.calls.append(("update", origin.key, changes))
        return RecordItem(origin=origin, data=RecordData(title="Acme renewal"))

    async def delete(self, origin):
        self.calls.append(("delete", origin.key))


class _Feed:
    """A driver that only reads."""


@pytest.fixture
def source(monkeypatch):
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import SourceItem

    driver, opened = {"it": _Crm()}, []

    class Live:
        def __init__(self):
            self.source = driver["it"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    async def open_(self, **kw):
        opened.append(self.id)
        return Live()

    async def get_one(match, *a, **k):
        if match.get("id") == "i1" and match.get("data_source_id"):
            return SimpleNamespace(id="i1", origin_kind="record", origin_namespace="crm.example", origin_key="OPP-1",
                                   delete=lambda: _dropped("i1"))
        return None

    async def ingest_items(specs, **kw):
        kept.extend(specs)
        return SimpleNamespace(outcomes=[SimpleNamespace(entity_id=f"kept-{s.external_id}") for s in specs])

    async def _dropped(item_id):
        dropped.append(item_id)

    kept, dropped = [], []
    monkeypatch.setattr(DataSource, "open", open_)
    monkeypatch.setattr(SourceItem, "get_one", get_one)
    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", ingest_items)
    src = DataSource(id=str(uuid.uuid4()), provider="crm", account_key="a", name="CRM deals", config={})
    driver["kept"], driver["dropped"] = kept, dropped
    return src, driver, opened


async def test_a_change_goes_back_to_the_outside_system_through_the_driver(source):
    src, driver, _ = source
    done = await src.update_item("i1", {"gtmPersona": "cfo"})
    assert driver["it"].calls == [("update", "OPP-1", {"gtmPersona": "cfo"})]
    assert done == {"item_id": "kept-OPP-1", "origin": CloudOrigin(kind="record", namespace="crm.example", key="OPP-1").model_dump(mode="json"), "status": "updated"}
    # what the outside system answered is kept at once, through the one ingest chokepoint -- not at the next sync
    assert [(k.data_source_id, k.external_id, k.name) for k in driver["kept"]] == [(src.id, "OPP-1", "Acme renewal")]
    assert (await src.delete_item("i1"))["status"] == "deleted" and driver["it"].calls[-1] == ("delete", "OPP-1")
    assert driver["dropped"] == ["i1"]                                         # and the record kept here goes with it


async def test_a_new_record_is_made_in_the_outside_system_and_kept_here(source):
    src, driver, _ = source
    done = await src.create_item({"title": "Call Acme back"})
    assert driver["it"].calls == [("create", "Call Acme back")]
    assert done["item_id"] == "kept-OPP-9" and done["status"] == "created" and done["origin"]["key"] == "OPP-9"
    with pytest.raises(ValueError, match="not a RecordData"):
        await src.create_item({"title": ["not", "text"]})
    with pytest.raises(ValueError, match="data"):
        await src.create_item({})
    src.read_only = True
    with pytest.raises(PermissionError, match="read-only"):
        await src.create_item({"title": "x"})
    src.read_only = False
    driver["it"] = _Feed()
    with pytest.raises(NotImplementedError, match="cannot create"):
        await src.create_item({"title": "x"})


async def test_a_write_back_is_refused_before_any_io(source):
    src, driver, opened = source
    with pytest.raises(LookupError, match="no item 'ghost'"):
        await src.update_item("ghost", {"x": 1})
    with pytest.raises(ValueError, match="changes"):
        await src.update_item("i1", {})
    src.read_only = True
    with pytest.raises(PermissionError, match="read-only"):
        await src.update_item("i1", {"x": 1})
    assert opened == [] and driver["it"].calls == []                           # the driver was never opened
    src.read_only = False
    driver["it"] = _Feed()
    with pytest.raises(NotImplementedError, match="the crm driver cannot update a record"):
        await src.update_item("i1", {"x": 1})
    with pytest.raises(NotImplementedError, match="cannot delete"):
        await src.delete_item("i1")


def test_the_write_back_and_mirror_actions_are_routable():
    import inspect

    from flow_sdk.actions.action_registry import action as registry
    from flow_sdk.builtin.data_source import DataSource

    registered = set(registry.function_registry)
    assert {"data_source.create_item", "data_source.update_item", "data_source.delete_item", "dataset.mirror"} <= registered
    for name in ("create_item_action", "update_item_action", "delete_item_action"):
        assert not set(inspect.signature(getattr(DataSource, name)).parameters) - {"self", "cls"}


async def test_the_mirror_action_over_http(deals, monkeypatch):
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.builtin.source_item import SourceItem
    from tests.unit._graph_client import call_local

    served = Dataset(id=str(uuid.uuid4()), name="deals-http", asset_ref=str(deals._folder().parent / "deals-http"),
                     data_layout="io_folder", spec={"rows": [{"input": deals.row_kind}]})
    await served.save()

    async def get_by_id(source_id, *a, **k):
        return SimpleNamespace(id=source_id, provider="crm") if source_id == "src-1" else None

    async def get_all(match, *a, **k):
        return [SimpleNamespace(model_dump=lambda mode="json", item=item: item) for item in ITEMS[:2]]

    monkeypatch.setattr(DataSource, "get_by_id", get_by_id)
    monkeypatch.setattr(SourceItem, "get_all", get_all)
    done = await call_local("POST", f"dataset/{served.id}/mirror", {"source_id": "src-1", "map": MAP})
    assert done.status_code == 200, done.text
    assert done.json()["data"] == {"created": ["opp-1", "opp-2"], "updated": [], "unchanged": [], "deleted": [], "num_rows": 2}
    assert (await call_local("POST", f"dataset/{served.id}/mirror", {"source_id": "ghost", "map": MAP})).status_code == 404
    assert (await call_local("POST", f"dataset/{served.id}/mirror", {"source_id": "src-1", "map": {"key": "external_id"}})).status_code == 400


# ── a record deleted in the outside system ───────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_record_deleted_outside_leaves_the_mirror(deals):
    """The whole loop on real records: the system drops a deal, the next sync removes its stored
    record (the source ``lists_everything``), and the next mirror drops its row."""
    from datetime import datetime, timezone

    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.ingest.sync import sync_source
    from flow_sdk.sources.base import CollectionSource
    from flow_sdk.sources.families import RecordSource
    from flow_sdk.sources.values.items import FeedItemData

    class Crm(RecordSource, CollectionSource):
        provider = "crmlisttest"
        lists_everything = True
        deals: dict = {"opp-1": "Acme renewal", "opp-2": "Bolt pilot"}

        def query(self):
            return None

        async def _lookup(self, key):
            return self.deals.get(key)

        async def _scan(self, query):
            return sorted(self.deals.items())

        def _item(self, key, raw):
            return SourceItemSpec(origin=self.origin(key), data=FeedItemData(title=raw))

    DataDriver.register(DataDriver.for_class(Crm, kind="datasource.test.crmlist"))
    source = DataSource(provider=Crm.provider, account_key=f"acct-{uuid.uuid4().hex[:8]}", name=f"crm {uuid.uuid4().hex[:8]}")
    await source.save()
    now = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
    shape = {"key": "name", "input": {"name": "name", "stage": {"value": "open"}, "crm_id": "external_id"}}

    assert (await sync_source(source, now=now)).created == 2
    assert sorted((await deals.mirror(source, shape, by="crm"))["created"]) == ["acme-renewal", "bolt-pilot"]

    del Crm.deals["opp-2"]                                                    # deleted in the CRM
    assert (await sync_source(await DataSource.get_one({"id": source.id}), now=now)).removed == 1
    done = await deals.mirror(source, shape, by="crm")
    assert (done["deleted"], done["unchanged"]) == (["bolt-pilot"], ["acme-renewal"])
    assert [r.key for r in deals.read_rows()] == ["acme-renewal"]


# ── the map: lists, and links made from the outside system's ids ─────────────


@pytest.fixture
def tasks(tmp_path):
    """Deals keyed by the CRM's id (``unique``), and tasks that link to any number of them -- or none."""
    import json

    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestmirlink" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}  # noqa: E731
    _schema(root, ns, "crm.deal", {"name": f("string"), "crm_id": f("string")})
    rules = root / "agentic-assets/data_schema/crm.deal/data_schema.json"
    rules.write_text(json.dumps({**json.loads(rules.read_text()), "rules": [{"unique": ["crm_id"]}]}))
    _schema(root, ns, "crm.note", {"name": f("string"), "crm_id": f("string")})                 # nothing unique
    _schema(root, ns, "crm.task", {"title": f("string", owned_by="crm"), "crm_id": f("string", owned_by="crm"),
                                   "labels": f(["string"], owned_by="crm"), "deals": f(["crm.deal"], owned_by="crm"),
                                   "main": f("?crm.deal", owned_by="crm"), "notes": f("?string")})
    assert not any(load_root(root).values())
    deals = _dataset(root, "deals", f"--{ns}--.crm.deal")
    _dataset(root, "notes", f"--{ns}--.crm.note")
    return deals, _dataset(root, "tasks", f"--{ns}--.crm.task")


TASKS = [
    {"external_id": "T-1", "name": "Call back", "data": {"labels": [{"name": "urgent"}, {"name": "q4"}],
                                                         "targets": [{"deal": "OPP-1"}, {"deal": "OPP-2"}, {"deal": "OPP-404"}]}},
    {"external_id": "T-2", "name": "Write the plan", "data": {"labels": [], "targets": []}},          # a general task
]
TASK_MAP = {"key": "external_id", "input": {
    "title": "name", "crm_id": "external_id", "labels": "data.labels.*.name",
    "deals": {"link": "crm.deal", "by": "crm_id", "path": "data.targets.*.deal"},
    "main": {"link": "crm.deal", "by": "crm_id", "path": "data.targets.0.deal"}}}


async def test_a_path_through_a_list_gives_a_list_and_ids_become_links(tasks):
    deals, tasks_ = tasks
    await deals.append([{"key": "acme", "input": {"name": "Acme", "crm_id": "OPP-1"}},
                        {"key": "bolt", "input": {"name": "Bolt", "crm_id": "OPP-2"}}])
    refs = {row["key"]: row["ref"] for row in deals.query()["rows"]}

    done = await tasks_.mirror(TASKS, TASK_MAP, by="crm")
    assert done["created"] == ["t-1", "t-2"]
    assert done["unlinked"] == [{"key": "t-1", "field": "deals", "value": "OPP-404"}]   # no such deal here: left out, said so
    rows = {row["key"]: row["input"] for row in tasks_.query()["rows"]}
    assert rows["t-1"]["labels"] == ["urgent", "q4"]
    assert rows["t-1"]["deals"] == [refs["acme"], refs["bolt"]] and rows["t-1"]["main"] == refs["acme"]
    assert rows["t-2"]["deals"] == [] and rows["t-2"].get("main") is None                      # a general task links nothing
    assert "unlinked" not in await tasks_.mirror(TASKS[1:], TASK_MAP, by="crm", prune=False)


async def test_a_link_is_made_only_by_a_unique_field(tasks):
    _, tasks_ = tasks
    by_name = {"key": "external_id", "input": {"title": "name", "main": {"link": "crm.deal", "by": "name", "path": "external_id"}}}
    with pytest.raises(ValueError, match="name is not a unique field of crm.deal"):
        await tasks_.mirror(TASKS, by_name, by="crm")
    with pytest.raises(ValueError, match="crm_id is not a unique field of crm.note"):
        await tasks_.mirror(TASKS, {"key": "external_id", "input": {"main": {"link": "crm.note", "by": "crm_id", "path": "x"}}}, by="crm")
    with pytest.raises(ValueError, match="no dataset holds crm.ghost"):
        await tasks_.mirror(TASKS, {"key": "external_id", "input": {"main": {"link": "crm.ghost", "by": "crm_id", "path": "x"}}}, by="crm")


DEAL_MAP = {"key": "external_id", "input": {"name": "name", "crm_id": "external_id"}}


async def test_a_record_gone_outside_stays_while_a_row_still_links_to_it(tasks):
    """One deal deleted in the outside system that a task still links to does not stop the mirror:
    that row is kept and named, every other change lands, and it goes once nothing links to it."""
    deals, tasks_ = tasks
    three = [{"external_id": f"OPP-{n}", "name": name} for n, name in ((1, "Acme"), (2, "Bolt"), (3, "Core"))]
    await deals.mirror(three, DEAL_MAP)
    await tasks_.mirror(TASKS, TASK_MAP, by="crm")                      # t-1 links to opp-1 and opp-2

    now = [{"external_id": "OPP-2", "name": "Bolt Ltd"}, {"external_id": "OPP-4", "name": "Dyne"}]   # 1 and 3 are gone
    done = await deals.mirror(now, DEAL_MAP)
    assert (done["created"], done["updated"], done["deleted"]) == (["opp-4"], ["opp-2"], ["opp-3"])
    (kept,) = done["referenced"]
    assert kept["key"] == "opp-1" and kept["details"][0]["code"] == "referenced" and "t-1" in kept["details"][0]["message"]
    assert sorted(r["key"] for r in deals.query()["rows"]) == ["opp-1", "opp-2", "opp-4"] and not tasks_.query()["problems"]
    with pytest.raises(ValueError, match="used by"):                    # a plain sync is still all or nothing
        await deals.sync([{"key": "opp-2", "input": {"name": "Bolt Ltd", "crm_id": "OPP-2"}}])

    await tasks_.mirror(TASKS[1:], TASK_MAP, by="crm")                  # the task that linked to it is gone
    assert (await deals.mirror(now, DEAL_MAP)) == {"created": [], "updated": [], "unchanged": ["opp-2", "opp-4"], "deleted": ["opp-1"]}


async def test_a_link_may_name_the_row_by_its_key_both_ways(tasks):
    """The outside system holds a KEY of a row that is ours (a tag): ``"by": "key"`` links it in, and
    a write sends the key back out."""
    from pathlib import Path

    from flow_sdk.datasets.projection import outside_changes

    deals, tasks_ = tasks
    await deals.append([{"key": "acme", "input": {"name": "Acme", "crm_id": "OPP-1"}}])
    by_key = {"key": "external_id", "input": {"title": "name", "crm_id": "external_id",
                                              "main": {"link": "crm.deal", "by": "key", "path": "data.tag"}}}
    done = await tasks_.mirror([{"external_id": "T-1", "name": "Call", "data": {"tag": "acme"}},
                                {"external_id": "T-2", "name": "Mail", "data": {"tag": "ghost"}}], by_key, by="crm", prune=False)
    rows = {r["key"]: r["input"] for r in tasks_.query()["rows"]}
    assert rows["t-1"]["main"] == deals.ref_of(deals.query()["rows"][0]["id"]) and rows["t-2"].get("main") is None
    assert done["unlinked"] == [{"key": "t-2", "field": "main", "value": "ghost"}]
    assert outside_changes(by_key, {"main": rows["t-1"]["main"]}, Path(tasks_._owner()), {}) == {"tag": "acme"}
