"""A dataset whose data source is a SYSTEM OF RECORD (a CRM): the row kind's ``truth`` fields come from
the system (``flow_sdk.datasets.truth``) and every other field is the row's own, kept in the project's
data store (``flow_sdk.datasets.stores``). Every read pulls the records in (``Dataset.mirror``); a change
to a truth field goes to the system first (``flow_sdk.datasets.projection.write_through``), a delete
removes the record first."""

import asyncio
import contextlib
import json
import uuid
from types import SimpleNamespace

import pytest

from tests.unit.test_data_spec.test_row_links import _dataset, _schema

pytestmark = pytest.mark.timeout(5)



class _Crm:
    """The record system: its records by id, and every write it was asked for."""

    def __init__(self, data_cls):
        self.records: dict = {}
        self.calls: list = []
        self.refuse = ""
        self.partial = ""      # set: the CRM makes the record but says this much of it was not made
        self.listed = 0        # how many times every record was listed
        self.listing_refused = False
        self.Data = data_cls

    def origin(self, key):
        from flow_sdk.sources.values.origin import CloudOrigin

        return CloudOrigin(kind="record", namespace="crm.example", key=key)

    def put(self, key, **fields):
        from flow_sdk.sources.values.items import RecordItem

        self.records[key] = RecordItem(origin=self.origin(key), data=self.Data(**fields))

    def source(self):
        crm = self

        class Source:
            def origin(self, key):
                return crm.origin(key)

            async def iterate(self, **kw):
                crm.listed += 1
                if crm.listing_refused:
                    raise ConnectionError("HTTP 429: too many requests")
                for item in list(crm.records.values()):
                    yield item

            async def get(self, origin):
                return crm.records.get(origin.key)

            async def create(self, data: crm.Data):          # the record shape `create` validates against
                from flow_sdk.sources.values.items import RecordItem

                if crm.refuse:
                    raise RuntimeError(crm.refuse)
                key = f"T-{len(crm.records) + 1}"
                crm.calls.append(("create", data.model_dump(exclude_defaults=True)))
                crm.records[key] = item = RecordItem(origin=crm.origin(key), data=data,
                                                     warnings=(crm.partial,) if crm.partial else ())
                return item

            async def update(self, origin, changes):
                from flow_sdk.sources.values.items import RecordItem

                await asyncio.sleep(0.05)                    # the outside system is a round trip away
                if crm.refuse:
                    raise RuntimeError(crm.refuse)
                crm.calls.append(("update", origin.key, changes))
                had = crm.records[origin.key].data.model_dump()
                crm.records[origin.key] = item = RecordItem(origin=origin, data=crm.Data(**{**had, **changes}))
                return item

            async def delete(self, origin):
                await asyncio.sleep(0.05)
                crm.calls.append(("delete", origin.key))
                crm.records.pop(origin.key, None)

        return Source()


def _crm_source(root, **more):
    folder = root / "agentic-assets" / "data_source" / "crm"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "data_source.json").write_text(json.dumps({"type": "data_source", "name": "crm", "data_driver_name": "crm", **more}))


@pytest.fixture
def served(tmp_path, monkeypatch):
    """A tasks dataset whose data source is a CRM; the CRM can write."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import stores
    from flow_sdk.schema.data_spec.declared import load_root
    from flow_sdk.sources.base import Family
    from flow_sdk.sources.values.items import RecordData

    root, ns = tmp_path / "proj", "unittestthru" + uuid.uuid4().hex[:8]
    f = lambda shape, **more: {"shape": shape, "description": "x", **more}  # noqa: E731
    _schema(root, ns, "crm.deal", {"name": f("string"), "crm_id": f("string")})
    rules = root / "agentic-assets/data_schema/crm.deal/data_schema.json"
    rules.write_text(json.dumps({**json.loads(rules.read_text()), "rules": [{"unique": ["crm_id"]}]}))
    _schema(root, ns, "crm.task", {"title": f("string", truth="soc.data.title"), "status": f("string", truth="soc"),
                                   "crm_id": f("?string", truth="soc.external_id"),
                                   "deals": f(["crm.deal"], truth={"link": "crm.deal", "by": "crm_id", "path": "soc.data.deal_ids.*"}),
                                   "seen": f("?string", truth="soc.occurred_at"), "label": f("?string", truth="soc"),
                                   "notes": f("?string")})
    assert not any(load_root(root).values())
    deals = _dataset(root, "deals", f"--{ns}--.crm.deal")

    class TaskData(RecordData):
        status: str | None = None
        label: str | None = None
        deal_ids: list[str] = []

    crm = _Crm(TaskData)
    _crm_source(root)
    tasks = Dataset(id=str(uuid.uuid4()), name="tasks", asset_ref=str(root / "agentic-assets/dataset/tasks"),
                    data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.task"}]}, data_source="crm")

    class CrmDriver:
        family = Family.RECORD

    real = stores._driver_class
    monkeypatch.setattr(stores, "_driver_class", lambda provider, folder="": CrmDriver if provider == "crm" else real(provider, folder))

    @contextlib.asynccontextmanager
    async def opener(where):
        assert where.driver == "crm"
        yield crm.source()

    async def ready(name, project_id=""):
        return ""

    monkeypatch.setattr(stores, "OPENER", opener)
    monkeypatch.setattr(stores, "source_refusal", ready)
    stores._checked.clear()
    return SimpleNamespace(tasks=tasks, deals=deals, crm=crm, TaskData=TaskData, root=root, ns=ns)


async def _call(served, action, body):
    from tests.unit._graph_client import call_local

    return await call_local("POST", f"dataset/{served.tasks.id}/{action}", body)


async def _seed(served):
    """The CRM holds T-1 (open, on the Acme deal) and the rows were pulled."""
    await served.tasks.save()
    await served.deals.append([{"key": "acme", "input": {"name": "Acme", "crm_id": "OPP-1"}},
                               {"key": "bolt", "input": {"name": "Bolt", "crm_id": "OPP-2"}}])
    served.crm.put("T-1", title="Call Acme back", status="TODO", deal_ids=["OPP-1"])
    await served.tasks.pull()
    return {row["key"]: row["ref"] for row in served.deals.query()["rows"]}


def _rows(tasks) -> dict:
    return {row["key"]: {k: v for k, v in row["input"].items() if v is not None} for row in tasks.query()["rows"]}


# ── the declaration ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("truth, says", [
    ("crm.title", "truth:"),
    ("soc.", "truth:"),
    ({"link": "crm.deal", "path": "soc.data.x"}, "truth:"),
    ({"link": "crm.deal", "by": "key", "path": "data.x"}, "truth:"),
])
def test_a_truth_is_checked_where_it_is_declared(truth, says):
    from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaField

    with pytest.raises(ValueError, match=says):
        DataSchemaField(shape="string", truth=truth)


def test_the_map_a_system_of_record_is_read_by_comes_from_the_truth_fields(served):
    from flow_sdk.datasets.truth import mirror_map

    shape = served.tasks.row_type.input_type()
    assert mirror_map(shape) == {"key": "external_id", "input": {
        "title": "data.title", "status": "data.status", "crm_id": "external_id",
        "deals": {"link": "crm.deal", "by": "crm_id", "path": "data.deal_ids.*"}, "seen": "occurred_at", "label": "data.label"}}


async def test_a_kind_without_a_field_for_the_records_id_is_refused(tmp_path):
    from flow_sdk.datasets.truth import mirror_map
    from flow_sdk.schema.data_spec.declared import load_root
    from flow_sdk.schema.data_spec.spec import DataSpec

    root, ns = tmp_path / "proj", "unittestthru" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.loose", {"title": {"shape": "string", "description": "x", "truth": "soc.data.title"}})
    assert not any(load_root(root).values())
    with pytest.raises(ValueError, match="soc.external_id"):
        mirror_map(DataSpec.parse(f"--{ns}--.crm.loose"))


# ── every read pulls ─────────────────────────────────────────────────────────


async def test_a_read_brings_the_records_in(served):
    await _seed(served)
    served.crm.put("T-2", title="Write the plan", status="DONE")
    rows = (await _call(served, "rows", {})).json()["data"]["rows"]
    assert {r["key"]: r["input"]["status"] for r in rows} == {"t-1": "TODO", "t-2": "DONE"}

    served.crm.records.pop("T-2")
    served.crm.put("T-1", title="Call Acme back", status="DONE", deal_ids=["OPP-1"])
    await served.tasks.pull()
    assert set(_rows(served.tasks)) == {"t-1"} and _rows(served.tasks)["t-1"]["status"] == "DONE" and served.crm.calls == []


async def test_the_rows_are_out_of_the_project(served):
    """A system of record's rows are kept whole in the project's data store, never in the project."""
    await _seed(served)
    assert not (served.root / "agentic-assets/dataset/tasks/rows").exists()
    assert (served.tasks._rows_root() / "rows" / "t-1" / "row.json").is_file()


async def test_a_record_that_does_not_fit_is_a_problem_row_not_a_lost_one(served):
    await _seed(served)
    served.crm.put("T-2", status="DONE")                                       # no title: the kind requires one
    await served.tasks.pull()
    kept, problems = served.tasks.rows_and_problems()
    assert [r.key for r in kept] == ["t-1"] and [p["key"] for p in problems] == ["t-2"]


async def test_the_pull_action_answers_what_moved(served):
    await _seed(served)
    served.crm.put("T-2", title="Write the plan", status="DONE")
    done = await _call(served, "pull", {})
    assert done.status_code == 200, done.text
    assert done.json()["data"] == {"moved": ["t-2"], "gone": [], "num_rows": 2}


# ── write-through: a row's system-owned fields go to the system ──────────────


async def test_an_owned_field_written_here_goes_to_the_outside_system_first(served):
    refs = await _seed(served)
    row = {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": [refs["acme"], refs["bolt"]]}}
    done = await _call(served, "put-row", {"key": "t-1", "row": row})
    assert done.status_code == 200, done.text
    # only what changed goes out, in the outside system's own names -- a link as the id it stands for
    assert served.crm.calls == [("update", "T-1", {"status": "DONE", "deal_ids": ["OPP-1", "OPP-2"]})]
    got = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"]
    assert (got["status"], got["deals"]) == ("DONE", [refs["acme"], refs["bolt"]])
    assert served.crm.records["T-1"].data.status == "DONE"


async def test_two_writes_from_one_version_one_reaches_the_outside_system_and_the_other_is_refused(served):
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    put = lambda status: _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": status}},  # noqa: E731
                                                    "expected": row["version"]})
    done, waiting = await asyncio.gather(put("DONE"), put("WAITING"))
    assert sorted([done.status_code, waiting.status_code]) == [200, 409], (done.text, waiting.text)
    won = "DONE" if done.status_code == 200 else "WAITING"
    assert served.crm.calls == [("update", "T-1", {"status": won})]          # the stale one never went out
    assert next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"]["status"] == won


async def test_a_change_and_a_delete_from_one_version_do_not_both_go_out(served):
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    put = _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": "DONE"}}, "expected": row["version"]})
    delete = _call(served, "delete-row", {"key": "t-1", "expected": row["version"]})
    done, gone = await asyncio.gather(put, delete)
    assert sorted([done.status_code, gone.status_code]) == [200, 409], (done.text, gone.text)
    assert len(served.crm.calls) == 1                                        # only the winner went out


async def test_a_new_row_is_a_new_record_and_takes_its_key_from_it(served):
    refs = await _seed(served)
    done = await _call(served, "append", {"rows": [{"input": {"title": "Send the deck", "status": "TODO", "deals": [refs["bolt"]]}}]})
    assert done.status_code == 200, done.text
    assert served.crm.calls == [("create", {"title": "Send the deck", "status": "TODO", "deal_ids": ["OPP-2"]})]
    got = {r["key"]: {k: v for k, v in r["input"].items() if v is not None} for r in served.tasks.query()["rows"]}
    # the row is keyed as the map keys the record (``T-2`` → ``t-2``)
    assert got["t-2"] == {"title": "Send the deck", "status": "TODO", "crm_id": "T-2", "deals": [refs["bolt"]]}
    assert done.json()["data"]["ids"] and set(got) == {"t-1", "t-2"}
    assert "warnings" not in done.json() and "warnings" not in done.json()["data"]


async def test_a_record_made_with_a_warning_is_kept_and_the_warning_reaches_the_caller(served):
    refs = await _seed(served)
    served.crm.partial = "deal OPP-9 could not be linked"
    done = await _call(served, "append", {"rows": [{"input": {"title": "Send the deck", "status": "TODO", "deals": [refs["bolt"]]}}]})
    assert done.status_code == 200, done.text
    said = [{"error_code": "source_partial", "message": "crm: deal OPP-9 could not be linked", "key": "t-2"}]
    assert done.json()["data"]["warnings"] == said and done.json()["warnings"] == said
    assert {r["key"] for r in served.tasks.query()["rows"]} == {"t-1", "t-2"}


async def test_a_list_link_with_unresolved_ids_is_not_written_back(served):
    """The CRM's task is on two deals; only one has a row here, so the pull linked one. Writing the
    row's `deals` as it stands would make the CRM's links exactly that one: refused, before any I/O."""
    refs = await _seed(served)
    served.crm.put("T-1", title="Call Acme back", status="TODO", deal_ids=["OPP-1", "OPP-9"])
    await served.tasks.pull()
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    assert row["input"]["deals"] == [refs["acme"]]

    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "deals": [refs["acme"], refs["bolt"]]}}})
    assert done.status_code == 400, done.text
    details = done.json()["data"]["details"]
    assert [(d["code"], d["path"]) for d in details] == [("unlinked", "input.deals")]
    assert "OPP-9" in details[0]["message"] and served.crm.calls == []
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": "DONE"}}})
    assert done.status_code == 200, done.text
    assert served.crm.calls == [("update", "T-1", {"status": "DONE"})]


async def test_a_delete_here_deletes_the_record_there(served):
    await _seed(served)
    done = await _call(served, "delete-row", {"key": "t-1"})
    assert done.status_code == 200, done.text
    assert served.crm.calls == [("delete", "T-1")] and served.tasks.query()["rows"] == [] and served.crm.records == {}


async def test_a_refusal_from_the_outside_system_writes_nothing(served):
    await _seed(served)
    served.crm.refuse = "status DONE needs an assignee"
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 400
    assert [d["code"] for d in done.json()["data"]["details"]] == ["source_refused"] and "needs an assignee" in done.text
    assert served.tasks.query()["rows"][0]["input"]["status"] == "TODO"


async def test_a_field_that_cannot_go_back_is_refused_before_any_io(served):
    await _seed(served)
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "TODO", "crm_id": "T-1", "deals": [], "seen": "now"}}})
    assert done.status_code == 400 and [d["code"] for d in done.json()["data"]["details"]] == ["not_writable"]
    assert served.crm.calls == []


async def test_a_read_only_source_keeps_its_fields_the_systems(served):
    await _seed(served)
    _crm_source(served.root, read_only=True)
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 400 and {(d["path"], d["code"]) for d in done.json()["data"]["details"]} == {("input.status", "owned"), ("input.deals", "owned")}
    assert served.crm.calls == []


async def test_the_system_itself_writes_as_the_system_and_nothing_goes_out(served):
    await _seed(served)
    done = await _call(served, "put-row", {"key": "t-1", "by": "soc", "row": {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": []}}})
    assert done.status_code == 200 and served.crm.calls == []


async def test_a_field_of_our_own_is_kept_in_the_data_store_beside_the_systems(served):
    """``notes`` is no field of the CRM's: it is the row's own. It is written here (nothing goes out) and
    stays through every pull of the system's fields."""
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "notes": "ours"}}})
    assert done.status_code == 200, done.text
    assert served.crm.calls == []
    served.crm.put("T-1", title="Call Acme back", status="DONE", deal_ids=["OPP-1"])
    await served.tasks.pull()
    assert (_rows(served.tasks)["t-1"]["notes"], _rows(served.tasks)["t-1"]["status"]) == ("ours", "DONE")


async def test_a_record_gone_from_the_system_keeps_a_row_that_holds_our_own_fields(served):
    await _seed(served)
    served.crm.put("T-2", title="Write the plan", status="TODO")
    await served.tasks.pull()
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    await served.tasks.put("t-1", {"input": {**row["input"], "notes": "met them twice"}})
    served.crm.records.clear()
    done = await served.tasks.pull()
    assert done["gone"] == ["t-1"]
    assert set(_rows(served.tasks)) == {"t-1"} and _rows(served.tasks)["t-1"]["notes"] == "met them twice"


async def test_the_same_write_from_python_goes_out_too_but_only_the_server_sends_it(served, monkeypatch):
    """One way in: ``Dataset.put`` sends a system-owned change to its system first, exactly as the row
    action does -- in the server. Outside it, the change is refused."""
    from flow_sdk.builtin.dataset import LinkError
    from flow_sdk.tags import ws_forward

    refs = await _seed(served)
    row = {"input": {"title": "Call Acme back", "status": "DONE", "crm_id": "T-1", "deals": [refs["acme"]]}}
    with pytest.raises(LinkError) as refused:
        await served.tasks.put("t-1", row)
    assert refused.value.details[0]["code"] == "owned" and served.crm.calls == []

    monkeypatch.setattr(ws_forward, "_started", True)                            # the server
    await served.tasks.put("t-1", row)
    assert served.crm.calls == [("update", "T-1", {"status": "DONE"})]
    await served.tasks.put_many([{"key": "t-1", "input": {**row["input"], "status": "TODO"}}])
    assert served.crm.calls[-1] == ("update", "T-1", {"status": "TODO"})
    (made,) = await served.tasks.append([{"input": {"title": "Send the deck", "status": "TODO", "deals": []}}])
    assert served.crm.calls[-1][0] == "create" and made
    got = {r["key"]: r["input"] for r in served.tasks.query()["rows"]}
    assert got["t-1"]["status"] == "TODO" and got["t-2"]["title"] == "Send the deck"


async def test_a_field_left_out_of_the_row_is_cleared_in_the_outside_system_too(served):
    refs = await _seed(served)
    row = {"title": "Call Acme back", "status": "TODO", "crm_id": "T-1", "deals": [refs["acme"]]}
    assert (await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row, "label": "hot"}}})).status_code == 200
    cleared = await _call(served, "put-row", {"key": "t-1", "row": {"input": row}})          # no `label` at all
    assert cleared.status_code == 200, cleared.text
    assert served.crm.calls == [("update", "T-1", {"label": "hot"}), ("update", "T-1", {"label": None})]
    assert next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")["input"].get("label") is None


async def test_a_row_takes_its_records_id_so_links_hold_on_every_machine(served):
    """A record whose id is an entity id (Twenty's are uuids) gives its row that id: two working copies
    (two machines) hold the same row under the same id, so a link to it from elsewhere holds."""
    from flow_sdk.builtin.dataset import Dataset

    await _seed(served)
    crm_id = str(uuid.uuid4())
    served.crm.put(crm_id, title="Ship it", status="TODO")
    await served.tasks.pull()
    row = next(r for r in served.tasks.query()["rows"] if r["input"]["crm_id"] == crm_id)
    assert row["id"] == crm_id and row["ref"].endswith(f".id.{crm_id}")
    other = Dataset(id=str(uuid.uuid4()), name="tasks-elsewhere", asset_ref=served.tasks.asset_ref, data_layout="io_folder",
                    spec=served.tasks.spec, data_source="crm")
    await other.pull()
    assert next(r for r in other.query()["rows"] if r["input"]["crm_id"] == crm_id)["id"] == crm_id
    assert next(r for r in other.query()["rows"] if r["key"] == "t-1")["id"] != crm_id      # "T-1" is no uuid: minted


async def test_a_write_reads_the_whole_system_once_and_never_after(served):
    """The rows are read once before a write (the session's pull); what the system answered the write
    with becomes the row -- no second listing, so a rate-limited listing after the write can never
    report a write that happened as one that failed."""
    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    before = served.crm.listed
    done = await _call(served, "put-row", {"key": "t-1", "row": {"input": {**row["input"], "status": "DONE"}}})
    assert done.status_code == 200, done.text
    assert served.crm.listed == before + 1 and served.crm.calls == [("update", "T-1", {"status": "DONE"})]
    assert _rows(served.tasks)["t-1"]["status"] == "DONE"


async def test_a_script_write_of_truth_fields_is_refused_in_bulk_too(served):
    """Outside the server no write reaches the system: a bulk write that changes a truth field is refused
    whole (``owned``); one that touches only the row's own fields is written."""
    from flow_sdk.builtin.dataset import LinkError

    await _seed(served)
    row = next(r for r in served.tasks.query()["rows"] if r["key"] == "t-1")
    for write in (served.tasks.put_many, served.tasks.sync):
        with pytest.raises(LinkError) as refused:
            await write([{"key": "t-1", "input": {**row["input"], "status": "DONE"}}])
        assert {d["code"] for d in refused.value.details} == {"owned"}
    await served.tasks.put_many([{"key": "t-1", "input": {**row["input"], "notes": "ours"}}])
    assert _rows(served.tasks)["t-1"]["notes"] == "ours" and served.crm.calls == []
