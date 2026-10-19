"""The DECLARED mirror: a data source names a dataset of its project (``mirror`` in its
``data_source.json``), and after every sync that dataset is made the mirror of its records
(``flow_sdk.datasets.projection``) -- nobody has to call ``Dataset.mirror``."""

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
    return {row["key"]: {k: v for k, v in row["input"].items() if v is not None} for row in tasks.query()["rows"]}


# ── the declaration ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("mirror, says", [
    ({"dataset": "", "map": MAP}, "mirror.dataset"),
    ({"dataset": "../x", "map": MAP}, "mirror.dataset"),
    ({"dataset": "tasks", "map": {"key": "external_id"}}, "mirror.map"),
    ({"dataset": "tasks", "map": {"key": "external_id", "input": {"title": "name"}}}, "map the key path 'external_id' to a field"),
    ({"dataset": "tasks", "map": MAP, "into": "x"}, "mirror:"),
    ({"dataset": "tasks", "map": MAP, "by": "The CRM"}, "mirror.by"),
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


# ── the source row says how its mirror stands ────────────────────────────────


@pytest.fixture
def stamped(project, monkeypatch):
    """``save_runtime`` recorded instead of hitting the store: what the row would persist."""
    from flow_sdk.builtin.data_source import DataSource

    saved = []

    async def save_runtime(self):
        saved.append((self.health, self.error_code, self.error_detail))

    monkeypatch.setattr(DataSource, "save_runtime", save_runtime)
    return saved


async def test_a_broken_mirror_is_said_on_the_source_row(project, stamped):
    """The sweep failed: the card reads it like a held write-back -- healthy, polling, needs a person."""
    from flow_sdk.datasets.projection import _on_sync

    source, _, _ = project
    source.health = "ok"
    source.mirror = {"dataset": "ghosts", "map": MAP}
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert source.health == "ok" and source.error_code == "mirror_failed"
    assert "'ghosts'" in source.error_detail
    assert stamped == [("ok", "mirror_failed", source.error_detail)]


async def test_a_mirror_that_works_again_clears_the_mark(project, stamped):
    from flow_sdk.datasets.projection import _on_sync

    source, tasks, _ = project
    source.mirror = {"dataset": "ghosts", "map": MAP}
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    source.mirror = {"dataset": "tasks", "map": MAP}
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert (source.error_code, source.error_detail) == (None, None) and len(_rows(tasks)) == 2
    assert len(stamped) == 2
    # Fine and unmarked: a good sweep writes nothing.
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert len(stamped) == 2


async def test_another_codes_mark_is_not_the_mirrors_to_clear(project, stamped):
    from flow_sdk.datasets.projection import _on_sync

    source, _, _ = project
    source.error_code, source.error_detail = "write_back_held", "notes.md"
    await _on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert (source.error_code, source.error_detail) == ("write_back_held", "notes.md") and stamped == []


async def test_records_that_do_not_fit_are_counted_on_the_row(project, stamped, monkeypatch):
    """The sweep ran but some records did not fit the row kind (``misfit``): said with its own code."""
    from flow_sdk.datasets import projection

    source, _, _ = project

    async def with_misfits(src):
        return {"created": [], "updated": [], "unchanged": [], "deleted": [], "misfit": [{"key": "t-2", "details": []}]}

    monkeypatch.setattr(projection, "project_source", with_misfits)
    await projection._on_sync(SimpleNamespace(data={"source_id": source.id}))
    assert source.error_code == "mirror_misfit" and source.error_detail == "1 record(s) did not fit the row kind: t-2"
    assert len(stamped) == 1


# ── write-through: a row's outside-owned fields go to the outside system ─────


class _Store:
    """The outside system and this machine's cache of it, in one: the CRM's tasks by id, and the
    records kept here (``SourceItem``) as the ingest chokepoint would keep them."""

    def __init__(self):
        self.records: dict[str, dict] = {}
        self.calls: list = []
        self.refuse = ""
        self.partial = ""      # set: the CRM makes the record but says this much of it was not made

    def keep(self, spec) -> str:
        dumped = spec.model_dump(mode="json")
        item = {"id": f"i-{dumped['external_id']}", **dumped}
        self.records[dumped["external_id"]] = item
        return item["id"]

    def row(self, item):
        return SimpleNamespace(id=item["id"], origin_kind="record", origin_namespace="crm.example", origin_key=item["external_id"],
                               model_dump=lambda mode="json", item=item: item, delete=lambda item=item: self._drop(item))

    async def _drop(self, item):
        self.records.pop(item["external_id"], None)


@pytest.fixture
def served(tmp_path, monkeypatch):
    """A served tasks dataset that a CRM source mirrors into; the CRM can write."""
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.schema.data_spec.declared import load_root
    from flow_sdk.sources.values.items import RecordData, RecordItem
    from flow_sdk.sources.values.origin import CloudOrigin

    root, ns = tmp_path / "proj", "unittestthru" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}  # noqa: E731
    _schema(root, ns, "crm.deal", {"name": f("string"), "crm_id": f("string")})
    rules = root / "agentic-assets/data_schema/crm.deal/data_schema.json"
    import json
    rules.write_text(json.dumps({**json.loads(rules.read_text()), "rules": [{"unique": ["crm_id"]}]}))
    _schema(root, ns, "crm.task", {"title": f("string", owned_by="crm"), "status": f("string", owned_by="crm"),
                                   "crm_id": f("?string", owned_by="crm"), "deals": f(["crm.deal"], owned_by="crm"),
                                   "seen": f("?string", owned_by="crm"), "label": f("?string", owned_by="crm"),
                                   "notes": f("?string")})
    assert not any(load_root(root).values())
    deals = _dataset(root, "deals", f"--{ns}--.crm.deal")
    folder = root / "agentic-assets/dataset/tasks"                       # made by the save (``_seed``)
    tasks = Dataset(id=str(uuid.uuid4()), name="tasks", asset_ref=str(folder), data_layout="io_folder",
                    spec={"rows": [{"input": f"--{ns}--.crm.task"}]})
    store = _Store()

    class TaskData(RecordData):
        status: str | None = None
        label: str | None = None
        deal_ids: list[str] = []

    class Crm:
        async def create(self, data: TaskData):          # the record shape `create_item` checks against
            if store.refuse:
                raise RuntimeError(store.refuse)
            key = f"T-{len(store.records) + 1}"
            store.calls.append(("create", data.model_dump(exclude_defaults=True)))
            return RecordItem(origin=CloudOrigin(kind="record", namespace="crm.example", key=key), data=data,
                              warnings=(store.partial,) if store.partial else ())

        async def update(self, origin, changes):
            await asyncio.sleep(0.05)                    # the outside system is a round trip away
            if store.refuse:
                raise RuntimeError(store.refuse)
            store.calls.append(("update", origin.key, changes))
            had = store.records[origin.key]["data"] or {}
            return RecordItem(origin=origin, data=TaskData(**{**{k: v for k, v in had.items() if k in TaskData.model_fields}, **changes}))

        async def delete(self, origin):
            await asyncio.sleep(0.05)
            store.calls.append(("delete", origin.key))

    class Live:
        source = Crm()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    source_folder = root / "agentic-assets/data_source/crm-tasks"
    source_folder.mkdir(parents=True)
    source = DataSource(id=str(uuid.uuid4()), provider="crm", account_key="a", name="CRM tasks", asset_ref=str(source_folder),
                        mirror={"dataset": "tasks", "map": {"key": "external_id", "input": {
                            "title": "data.title", "status": "data.status", "crm_id": "external_id", "seen": "occurred_at",
                            "label": "data.label",
                            "deals": {"link": "crm.deal", "by": "crm_id", "path": "data.deal_ids.*"}}}})

    async def ingest_items(specs, **kw):
        return SimpleNamespace(outcomes=[SimpleNamespace(entity_id=store.keep(s)) for s in specs])

    async def items(match, *a, **k):
        return [store.row(i) for i in store.records.values()] if match.get("data_source_id") == source.id else []

    async def item(match, *a, **k):
        wanted = {k: v for k, v in match.items() if k in ("id", "external_id")}
        found = next((i for i in store.records.values() if all(i.get(k) == v for k, v in wanted.items())), None) if wanted else None
        return store.row(found) if found else None

    async def item_by_id(item_id, *a, **k):
        return await item({"id": item_id})

    async def open_(self, **kw):
        return Live()

    async def sources(match, *a, **k):
        return [source]

    async def source_by_id(source_id, *a, **k):
        return source if source_id == source.id else None

    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", ingest_items)
    monkeypatch.setattr(SourceItem, "get_all", items)
    monkeypatch.setattr(SourceItem, "get_one", item)
    monkeypatch.setattr(SourceItem, "get_by_id", item_by_id)
    monkeypatch.setattr(DataSource, "open", open_)
    monkeypatch.setattr(DataSource, "get_all", sources)
    monkeypatch.setattr(DataSource, "get_by_id", source_by_id)
    return SimpleNamespace(tasks=tasks, deals=deals, source=source, store=store, TaskData=TaskData)


async def _call(served, action, body):
    from tests.unit._graph_client import call_local

    return await call_local("POST", f"dataset/{served.tasks.id}/{action}", body)


async def _seed(served):
    """The CRM holds T-1 (open, on the Acme deal) and the mirror has projected it."""
    from flow_sdk.datasets.projection import project_source
    from flow_sdk.sources.values.items import RecordItem
    from flow_sdk.sources.values.origin import CloudOrigin
    from flow_sdk.ingest.legacy_lift import envelope_of

    await served.tasks.save()
    await served.deals.append([{"key": "acme", "input": {"name": "Acme", "crm_id": "OPP-1"}},
                               {"key": "bolt", "input": {"name": "Bolt", "crm_id": "OPP-2"}}])
    first = RecordItem(origin=CloudOrigin(kind="record", namespace="crm.example", key="T-1"),
                       data=served.TaskData(title="Call Acme back", status="TODO", deal_ids=["OPP-1"]))
    served.store.keep(envelope_of(first, data_source_id=served.source.id, provider="crm"))
    await project_source(served.source)
    return {row["key"]: row["ref"] for row in served.deals.query()["rows"]}


async def test_an_owned_field_written_here_goes_to_the_outside_system_first(served):
    refs = await _seed(served)
    row = {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": [refs["acme"], refs["bolt"]], "notes": "ours"}}
    done = await _call(served, "put-row", {"key": "t-1", "row": row})
    assert done.status_code == 200, done.text
    # only what changed goes out, in the outside system's own names -- a link as the id it stands for
    assert served.store.calls == [("update", "T-1", {"status": "DONE", "deal_ids": ["OPP-1", "OPP-2"]})]
    got = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"]
    assert (got["status"], got["deals"], got["notes"]) == ("DONE", [refs["acme"], refs["bolt"]], "ours")
    assert served.store.records["T-1"]["data"]["status"] == "DONE"            # kept here at once, not at the next sync


async def test_two_writes_from_one_version_one_reaches_the_outside_system_and_the_other_is_refused(served):
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    put = lambda status: _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": status}},  # noqa: E731
                                                    "expected": row["version"]})
    done, waiting = await asyncio.gather(put("DONE"), put("WAITING"))
    assert sorted([done.status_code, waiting.status_code]) == [200, 409], (done.text, waiting.text)
    won = "DONE" if done.status_code == 200 else "WAITING"
    assert served.store.calls == [("update", "T-1", {"status": won})]          # the stale one never went out
    assert next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"]["status"] == won


async def test_a_change_and_a_delete_from_one_version_do_not_both_go_out(served):
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    put = _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": "DONE"}}, "expected": row["version"]})
    delete = _call(served, "delete-row", {"key": "t-1", "expected": row["version"]})
    done, gone = await asyncio.gather(put, delete)
    assert sorted([done.status_code, gone.status_code]) == [200, 409], (done.text, gone.text)
    assert len(served.store.calls) == 1                                        # only the winner went out


async def test_a_new_row_is_a_new_record_and_takes_its_key_from_it(served):
    refs = await _seed(served)
    done = await _call(served, "append", {"rows": [{"input": {"title": "Send the deck", "status": "TODO", "deals": [refs["bolt"]], "notes": "ours"}}]})
    assert done.status_code == 200, done.text
    assert served.store.calls == [("create", {"title": "Send the deck", "status": "TODO", "deal_ids": ["OPP-2"]})]
    got = {r["key"]: {k: v for k, v in r["input"].items() if v is not None} for r in served.tasks.query()["rows"]}
    # the row is keyed as the mirror keys the record (``T-2`` → ``t-2``): the app's own field rides along
    assert got["t-2"] == {"title": "Send the deck", "status": "TODO", "crm_id": "T-2", "deals": [refs["bolt"]], "notes": "ours"}
    assert done.json()["data"]["ids"] and set(got) == {"t-1", "t-2"}
    assert "warnings" not in done.json() and "warnings" not in done.json()["data"]


async def test_a_record_made_with_a_warning_is_kept_and_the_warning_reaches_the_caller(served):
    """The CRM made the task but not all of it (a link failed): the row is written as the record is,
    and the caller is told what was not set -- inside ``data``, where the SDK hands it on."""
    refs = await _seed(served)
    served.store.partial = "deal OPP-9 could not be linked"
    done = await _call(served, "append", {"rows": [{"input": {"title": "Send the deck", "status": "TODO", "deals": [refs["bolt"]]}}]})
    assert done.status_code == 200, done.text
    said = [{"error_code": "source_partial", "message": "crm: deal OPP-9 could not be linked", "key": "t-2"}]
    assert done.json()["data"]["warnings"] == said and done.json()["warnings"] == said
    assert {r["key"] for r in served.tasks.query()["rows"]} == {"t-1", "t-2"}


async def test_a_list_link_with_unresolved_ids_is_not_written_back(served):
    """The CRM's task is on two deals; only one has a row here, so the mirror linked one. Writing the
    row's `deals` as it stands would make Twenty's links exactly that one: refused, before any I/O."""
    from flow_sdk.datasets.projection import project_source
    from flow_sdk.ingest.legacy_lift import envelope_of
    from flow_sdk.sources.values.items import RecordItem
    from flow_sdk.sources.values.origin import CloudOrigin

    refs = await _seed(served)
    both = RecordItem(origin=CloudOrigin(kind="record", namespace="crm.example", key="T-1"),
                      data=served.TaskData(title="Call Acme back", status="TODO", deal_ids=["OPP-1", "OPP-9"]))
    served.store.keep(envelope_of(both, data_source_id=served.source.id, provider="crm"))
    assert (await project_source(served.source)).get("unlinked") == [{"key": "t-1", "field": "deals", "value": "OPP-9"}]
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    assert row["input"]["deals"] == [refs["acme"]]

    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "deals": [refs["acme"], refs["bolt"]]}}})
    assert done.status_code == 400, done.text
    details = done.json()["data"]["details"]
    assert [(d["code"], d["path"]) for d in details] == [("unlinked", "input.deals")]
    assert "OPP-9" in details[0]["message"] and served.store.calls == []
    # a field that is not the unresolved list still goes through
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": "DONE"}}})
    assert done.status_code == 200, done.text
    assert served.store.calls == [("update", "T-1", {"status": "DONE"})]


async def test_a_delete_here_deletes_the_record_there(served):
    await _seed(served)
    done = await _call(served, "delete-row", {"key": "t-1"})
    assert done.status_code == 200, done.text
    assert served.store.calls == [("delete", "T-1")] and served.tasks.query()["rows"] == [] and served.store.records == {}


async def test_a_refusal_from_the_outside_system_writes_nothing(served):
    await _seed(served)
    served.store.refuse = "status DONE needs an assignee"
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 400
    assert [d["code"] for d in done.json()["data"]["details"]] == ["source_refused"] and "needs an assignee" in done.text
    assert served.tasks.query()["rows"][0]["input"]["status"] == "TODO"


async def test_a_field_that_cannot_go_back_is_refused_before_any_io(served):
    await _seed(served)
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "TODO", "crm_id": "T-1", "deals": [], "seen": "now"}}})
    assert done.status_code == 400 and [d["code"] for d in done.json()["data"]["details"]] == ["not_writable"]
    assert served.store.calls == []


async def test_a_read_only_source_keeps_its_fields_its_own(served):
    await _seed(served)
    served.source.read_only = True
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 400 and {(d["path"], d["code"]) for d in done.json()["data"]["details"]} == {("input.status", "owned"), ("input.deals", "owned")}
    assert served.store.calls == []


async def test_the_mirror_itself_writes_as_the_outside_system_and_nothing_goes_out(served):
    await _seed(served)
    done = await _call(served, "put-row", {"key": "t-1", "by": "crm", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 200 and served.store.calls == []


async def test_a_change_to_the_apps_own_fields_stays_here(served):
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "notes": "ours"}}})
    assert done.status_code == 200 and served.store.calls == []


async def test_the_same_write_from_python_goes_out_too_but_only_the_server_can_send_it(served, monkeypatch):
    """One way in: ``Dataset.put`` sends an outside-owned change to its system first, exactly as the
    row action does -- in the server. A script holds no driver, so there the change is refused."""
    from flow_sdk.builtin.dataset import LinkError
    from flow_sdk.tags import ws_forward

    refs = await _seed(served)
    row = {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": [refs["acme"]], "notes": "ours"}}
    with pytest.raises(LinkError) as refused:                                   # a script: nothing went out
        await served.tasks.put("t-1", row)
    assert refused.value.details[0]["code"] == "owned" and served.store.calls == []

    monkeypatch.setattr(ws_forward, "_started", True)                            # the server
    await served.tasks.put("t-1", row)
    assert served.store.calls == [("update", "T-1", {"status": "DONE"})]
    await served.tasks.put_many([{"key": "t-1", "input": {**row["input"], "status": "TODO"}}])
    assert served.store.calls[-1] == ("update", "T-1", {"status": "TODO"})
    (made,) = await served.tasks.append([{"input": {"title": "Send the deck", "status": "TODO", "deals": []}}])
    assert served.store.calls[-1][0] == "create" and made
    got = {r["key"]: r["input"] for r in served.tasks.query()["rows"]}
    assert got["t-1"]["status"] == "TODO" and got["t-1"]["notes"] == "ours" and got["t-2"]["title"] == "Send the deck"


async def test_a_mirror_may_only_write_fields_the_schema_says_are_the_outside_systems(project, stamped):
    """A mapped field the app may write too would take an edit and lose it at the next sweep: the
    mirror is refused, by name, on the source card -- not left to eat edits."""
    from flow_sdk.builtin.dataset import LinkError
    from flow_sdk.datasets.projection import _project, project_source

    source, tasks, _ = project
    source.mirror = {"dataset": "tasks", "map": {**MAP, "input": {**MAP["input"], "notes": "data.notes"}}}
    with pytest.raises(LinkError) as refused:
        await project_source(source)
    assert refused.value.details[0]["code"] == "not_owned" and "notes" in str(refused.value)
    with pytest.raises(LinkError):
        await _project(source.id)
    assert source.error_code == "mirror_failed" and "notes" in source.error_detail and not tasks.query()["rows"]


async def test_a_field_left_out_of_the_row_is_cleared_in_the_outside_system_too(served):
    """A put replaces the row: an outside-owned field the caller leaves out is a field cleared -- sent to
    the system as empty, not refused as someone else's (how a page clears a tag)."""
    refs = await _seed(served)
    row = {"title": "Call Acme back", "status": "TODO", "crm_id": "T-1", "deals": [refs["acme"]]}
    assert (await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row, "label": "hot"}}})).status_code == 200
    cleared = await _call(served, "put-row", {"key": "t-1", "row": {"input": row}})          # no `label` at all
    assert cleared.status_code == 200, cleared.text
    assert served.store.calls == [("update", "T-1", {"label": "hot"}), ("update", "T-1", {"label": None})]
    assert next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"].get("label") is None
