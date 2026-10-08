"""A dataset's rows by KEY -- the example folder's name: append with a key, put (create or replace),
delete, rename, check, and the key on every row read back.

Before these, a dataset could only be appended to under numbered names, and a row did not say which
folder it was -- so an app that kept records in a dataset (GTM Studio) re-computed the uuid5 example
id in the browser and wrote the layout's files itself.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, ExampleSpec
from flow_sdk.schema.data_spec.layout import FolderLayout, example_id
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(5)

DATASET_ID = "6d9e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a"


class Lead(DataSpec):
    spec_kind: ClassVar[str] = "unittest.bykey.lead"
    name: str
    status: Literal["new", "won", "lost"] = "new"


class Score(DataSpec):
    spec_kind: ClassVar[str] = "unittest.bykey.score"
    value: int
    note: Optional[str] = None


class Leads(DatasetSpec[ExampleSpec[Lead, Score, DataSpec]]):
    spec_kind: ClassVar[str] = "unittest.bykey.dataset"


def _dataset(tmp_path):
    from flow_sdk.builtin.dataset import Dataset

    return Dataset(id=DATASET_ID, name="leads", asset_ref=str(tmp_path),
                   data_layout="io_folder", spec="unittest.bykey.dataset")


async def test_append_with_a_key_names_the_folder_and_the_row_says_its_key(tmp_path):
    d = _dataset(tmp_path)
    eid, numbered = await d.append([{"key": "acme", "input": {"name": "Acme"}}, {"input": {"name": "Beta"}}])
    assert (tmp_path / "examples/acme/input/lead.json").is_file()
    assert (tmp_path / "examples/0001").is_dir()
    assert eid == example_id(DATASET_ID, "acme")
    assert {r.key: r.id for r in d.read_rows()} == {"0001": numbered, "acme": eid}
    assert d.example("acme")["key"] == "acme"          # a key addresses a row like its id does
    assert {r["key"] for r in d._index()} == {"0001", "acme"}


async def test_a_taken_key_refuses_the_whole_batch(tmp_path):
    d = _dataset(tmp_path)
    await d.append([{"key": "acme", "input": {"name": "Acme"}}])
    with pytest.raises(ValueError, match="already taken"):
        await d.append([{"key": "fresh", "input": {"name": "F"}}, {"key": "acme", "input": {"name": "A2"}}])
    assert not (tmp_path / "examples/fresh").exists()


@pytest.mark.parametrize("bad", ["Acme", "../x", ".hidden", "", "a b"])
async def test_a_key_that_cannot_be_a_folder_name_is_refused(tmp_path, bad):
    with pytest.raises(ValueError, match="cannot be a row key"):
        await _dataset(tmp_path).append([{"key": bad, "input": {"name": "x"}}])


async def test_put_creates_then_replaces_and_keeps_gold_and_metadata(tmp_path):
    d = _dataset(tmp_path)
    eid = await d.put("acme", {"input": {"name": "Acme"}, "kind": "eval"})
    await d.annotate(eid, {"value": 3}, by="ami")
    assert await d.put("acme", {"input": {"name": "Acme Inc", "status": "won"}}) == eid
    row = d.example("acme")
    assert row["input"] == {"name": "Acme Inc", "status": "won"}
    assert row["ground_truth"] == {"value": 3, "note": None}    # an input edit never drops the gold
    assert row["kind"] == "eval"
    assert row["metadata"]["annotations"][0]["by"] == "ami"
    assert [p.name for p in (tmp_path / "examples").iterdir()] == ["acme"]   # no scratch dir left


async def test_a_put_that_does_not_fit_writes_nothing(tmp_path):
    d = _dataset(tmp_path)
    await d.put("acme", {"input": {"name": "Acme"}})
    with pytest.raises(ValidationError):
        await d.put("acme", {"input": {"name": "Acme", "status": "maybe"}})
    assert d.example("acme")["input"] == {"name": "Acme", "status": "new"}


async def test_delete_and_rename_by_key(tmp_path):
    d = _dataset(tmp_path)
    await d.append([{"key": "acme", "input": {"name": "Acme"}}, {"key": "beta", "input": {"name": "Beta"}}])
    new_id = d.rename_row("acme", "acme_corp")
    assert new_id == example_id(DATASET_ID, "acme_corp")
    assert d.example(new_id)["input"]["name"] == "Acme"
    with pytest.raises(ValueError, match="already taken"):
        d.rename_row("acme_corp", "beta")
    assert d.delete_row(example_id(DATASET_ID, "beta")) == "beta"     # an id works as well as a key
    assert [r.key for r in d.read_rows()] == ["acme_corp"]
    with pytest.raises(LookupError):
        d.delete_row("beta")


async def test_check_says_what_is_wrong_and_writes_nothing(tmp_path):
    d = _dataset(tmp_path)
    assert d.check({"input": {"name": "Acme"}}) == []
    errors = d.check({"input": {"name": "Acme", "status": "maybe"}})
    assert len(errors) == 1 and errors[0].startswith("input.status:")
    assert d.check({"inputs": {}}) == ["row 1: an object with an `input` is required"]
    assert not (tmp_path / "examples").exists()


def test_scratch_dirs_are_never_rows(tmp_path):
    FolderLayout().append_many(tmp_path, [(ExampleSpec[Lead, Score, DataSpec](input=Lead(name="A")), None)],
                               dataset_id=DATASET_ID)
    (tmp_path / "examples/.acme.new-1234/input").mkdir(parents=True)
    assert [r["key"] for r in FolderLayout().index(tmp_path, dataset_id=DATASET_ID)] == ["0001"]


def test_an_unknown_kind_never_checks_as_fitting():
    from flow_sdk.server.routes.kinds import check_value

    assert check_value("unittest.bykey.lead", {"name": "Acme"}) == []
    assert check_value("unittest.bykey.lead", {"name": "Acme", "status": "maybe"})[0].startswith("status:")
    assert check_value("int", "seven") != []
    assert check_value("unittest.bykey.nobody.defines.this", {"anything": 1}) is None


async def test_the_row_actions_over_http(tmp_path):
    """``put-row`` / ``check-row`` / ``rename-row`` / ``delete-row`` and ``rows`` through the real
    graph dispatcher: what the TS ``Dataset`` client and the data-management skill call."""
    from tests.unit._graph_client import call_local

    d = _dataset(tmp_path)
    await d.save()
    base = f"dataset/{d.id}"

    resp = await call_local("POST", f"{base}/put-row", {"key": "acme", "row": {"input": {"name": "Acme"}}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["example_id"] == example_id(DATASET_ID, "acme")

    bad = await call_local("POST", f"{base}/put-row", {"key": "acme", "row": {"input": {"status": "maybe"}}})
    assert bad.status_code == 400 and bad.json()["data"]["errors"]

    check = (await call_local("POST", f"{base}/check-row", {"row": {"input": {"name": 7}}})).json()["data"]
    assert check["ok"] is False and check["errors"][0].startswith("input.name:")

    renamed = await call_local("POST", f"{base}/rename-row", {"key": "acme", "new_key": "acme_corp"})
    assert renamed.json()["data"]["key"] == "acme_corp"
    rows = (await call_local("GET", f"{base}/rows")).json()["data"]["rows"]
    assert [(r["key"], r["input"]["name"]) for r in rows] == [("acme_corp", "Acme")]

    gone = await call_local("POST", f"{base}/delete-row", {"key": "acme_corp"})
    assert gone.status_code == 200 and gone.json()["data"]["num_examples"] == 0
    assert (await call_local("POST", f"{base}/delete-row", {"key": "acme_corp"})).status_code == 404


async def test_the_kind_check_route_answers_a_real_404_for_an_unknown_kind():
    """A plain route's ``ApiFailResponse`` answered HTTP 200 -- and the SDK client unwraps a 200 to
    ``data``, so ``checkKind`` handed back ``null`` for a kind nobody defines (found on a live probe)."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from flow_sdk.server.routes.kinds import router

    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        ok = await client.post("/api/v1/kinds/unittest.bykey.lead/check", json={"value": {"name": "Acme"}})
        assert ok.status_code == 200 and ok.json()["data"] == {"kind": "unittest.bykey.lead", "ok": True, "errors": []}
        bad = await client.post("/api/v1/kinds/unittest.bykey.lead/check", json={"value": {"status": "won"}})
        assert bad.json()["data"]["ok"] is False
        unknown = await client.post("/api/v1/kinds/unittest.bykey.nobody/check", json={"value": {}})
        assert unknown.status_code == 404 and unknown.json()["status"] == "FAIL"
        assert (await client.get("/api/v1/kinds/unittest.bykey.nobody")).status_code == 404
        assert (await client.post("/api/v1/kinds/unittest.bykey.lead/check", json={})).status_code == 400


async def test_a_row_kind_nobody_registered_is_named_not_read_as_any(tmp_path):
    """A ``dataset.json`` whose inline spec names a kind not registered yet (a script that skipped
    ``load_root``) kept no spec at all -- every row then failed as artifact shapes (``FolderSpec`` /
    ``TextSpec``) without naming the kind. The spec now survives the read and the typed read names it."""
    import json

    from flow_sdk.builtin.dataset import Dataset

    folder = tmp_path / "leads"
    folder.mkdir()
    (folder / "dataset.json").write_text(json.dumps({"metadata": {
        "data_layout": "io_folder", "spec": {"examples": [{"input": "--nobodyns--.crm.lead"}]}}, "data": {}}))
    d = Dataset.at(folder)
    assert d.spec == {"examples": [{"input": "--nobodyns--.crm.lead"}]}
    with pytest.raises(ValueError, match="names a kind nobody registered"):
        await d.put("dana", {"input": {"name": "Dana"}})
