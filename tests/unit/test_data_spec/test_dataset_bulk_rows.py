"""Many rows in one step: ``put_many`` (create or replace, all or nothing), ``sync`` (make the dataset
hold exactly these rows -- what a mirror of an outside system calls each run) and ``delete_rows``
over HTTP. One lock, one read of whatever the checks need, for the whole call.

On the same real project tree as ``test_row_links`` (schemas registered with ``load_root``).
"""

from __future__ import annotations

import pytest

from tests.unit.test_data_spec import test_row_links

crm = test_row_links.crm   # the same project tree: two schemas that link, two datasets side by side

pytestmark = pytest.mark.timeout(5)


def _lead(name, **more):
    return {"input": {"name": name, "past": [], "notes": [], **more}}


def _names(dataset):
    return {r.key: r.input.name for r in dataset.read_rows()}


async def test_put_many_creates_and_replaces_in_one_call(crm):
    _, companies, _ = crm
    await companies.put("acme", {"input": {"name": "Acme"}})
    before = companies.example("acme")
    ids = await companies.put_many([{"key": "acme", "input": {"name": "Acme Inc"}}, {"key": "bolt", "input": {"name": "Bolt"}}])
    assert _names(companies) == {"acme": "Acme Inc", "bolt": "Bolt"}
    assert ids[0] == before["id"] and len(set(ids)) == 2          # a replaced row keeps its id


async def test_put_many_writes_nothing_when_one_row_does_not_fit(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, companies, leads = crm
    await companies.put("acme", {"input": {"name": "Acme"}})
    ghost = companies.ref_of("0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")
    with pytest.raises(LinkError) as refused:
        await leads.put_many([{"key": "dana", **_lead("Dana")}, {"key": "eli", **_lead(7)}, {"key": "fay", **_lead("Fay", company=ghost)}])
    assert sorted((d["path"], d["code"].split(":")[0]) for d in refused.value.details) == [
        ("eli.input.name", "shape"), ("fay.input.company", "dangling_ref")]       # every bad row, by key, at once
    assert leads.read_rows() == []
    with pytest.raises(ValueError, match="given twice"):
        await companies.put_many([{"key": "x", "input": {"name": "X"}}, {"key": "x", "input": {"name": "Y"}}])
    with pytest.raises(ValueError, match="a `key` is required"):
        await companies.put_many([{"input": {"name": "X"}}])
    assert _names(companies) == {"acme": "Acme"}


async def test_put_many_refuses_the_batch_when_a_row_changed_since(crm):
    from flow_sdk.builtin.dataset import ConflictError

    _, companies, _ = crm
    await companies.put_many([{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt"}}])
    seen = {k: companies.example(k)["version"] for k in ("acme", "bolt")}
    await companies.put("bolt", {"input": {"name": "Bolt Ltd"}})                   # someone else, meanwhile
    with pytest.raises(ConflictError, match="bolt"):
        await companies.put_many([{"key": "acme", "input": {"name": "A2"}}, {"key": "bolt", "input": {"name": "B2"}}], expected=seen)
    assert _names(companies) == {"acme": "Acme", "bolt": "Bolt Ltd"}


async def test_a_batch_reads_what_its_checks_need_once(crm, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.datasets import links

    _, companies, leads = crm
    (acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    scans = []
    real = links._row_ids
    monkeypatch.setattr(links, "_row_ids", lambda folder: scans.append(folder.name) or real(folder))
    await leads.put_many([{"key": f"l{n}", **_lead(f"L{n}", company=companies.ref_of(acme))} for n in range(6)])
    assert scans == ["companies"]                                 # six rows link to it: its rows are listed once

    reads = []
    real_read = Dataset.read_lenient
    monkeypatch.setattr(Dataset, "read_lenient", lambda self: reads.append(self._folder().name) or real_read(self))
    await leads.put_many([{"key": f"l{n}", **_lead(f"M{n}")} for n in range(6)])   # replacing rows: no schema here has a rule
    assert reads == []


async def test_sync_makes_the_dataset_hold_exactly_the_rows_given(crm):
    _, companies, _ = crm
    await companies.put_many([{"key": k, "input": {"name": k.title()}} for k in ("acme", "bolt", "core")])
    untouched = companies.example("acme")["version"]
    done = await companies.sync([{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt Ltd"}},
                                 {"key": "dyne", "input": {"name": "Dyne"}}])
    assert done == {"created": ["dyne"], "updated": ["bolt"], "unchanged": ["acme"], "deleted": ["core"]}
    assert _names(companies) == {"acme": "Acme", "bolt": "Bolt Ltd", "dyne": "Dyne"}
    assert companies.example("acme")["version"] == untouched      # a row that reads the same is not rewritten
    again = await companies.sync([{"key": k, "input": {"name": n}} for k, n in _names(companies).items()])
    assert (again["created"], again["updated"], again["deleted"]) == ([], [], [])
    assert (await companies.sync([], prune=False)) == {"created": [], "updated": [], "unchanged": [], "deleted": []}
    assert len(companies.read_rows()) == 3


async def test_sync_prunes_only_the_slice_it_is_given(crm):
    _, companies, _ = crm
    await companies.put_many([{"key": k, "input": {"name": n}} for k, n in
                              [("crm_a", "A"), ("crm_b", "B"), ("hand_x", "X")]])
    mine = {"op": "$LIKE", "operands": ["key", "crm_"]}
    done = await companies.sync([{"key": "crm_a", "input": {"name": "A"}}], match=mine)
    assert done["deleted"] == ["crm_b"] and sorted(_names(companies)) == ["crm_a", "hand_x"]


async def test_sync_is_all_or_nothing(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, companies, leads = crm
    ids = await companies.put_many([{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt"}}])
    await leads.append([{"key": "dana", **_lead("Dana", company=companies.ref_of(ids[1]))}])
    with pytest.raises(LinkError, match="used by .* dana"):       # bolt would be pruned, and dana still names it
        await companies.sync([{"key": "acme", "input": {"name": "Acme Inc"}}, {"key": "core", "input": {"name": "Core"}}])
    with pytest.raises(LinkError):                                # a row that does not fit
        await companies.sync([{"key": "acme", "input": {"name": 7}}], prune=False)
    assert _names(companies) == {"acme": "Acme", "bolt": "Bolt"}


async def test_sync_repairs_a_row_that_no_longer_fits_and_prunes_one_too(crm):
    root, companies, _ = crm
    await companies.put_many([{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt"}}])
    for key in ("acme", "bolt"):
        doc = next((root / f"agentic-assets/dataset/companies/examples/{key}/input").glob("*.json"))
        doc.write_text('{"name": 7}')
    assert len(companies.rows_and_problems()[1]) == 2
    done = await companies.sync([{"key": "acme", "input": {"name": "Acme"}}])
    assert done == {"created": [], "updated": ["acme"], "unchanged": [], "deleted": ["bolt"]}
    assert companies.rows_and_problems()[1] == [] and _names(companies) == {"acme": "Acme"}


async def test_the_bulk_actions_over_http(tmp_path):
    from tests.unit._graph_client import call_local
    from tests.unit.test_data_spec.test_dataset_rows_by_key import _dataset as plain

    d = plain(tmp_path)
    await d.save()
    base = f"dataset/{d.id}"
    put = await call_local("POST", f"{base}/put-rows", {"rows": [{"key": "acme", "input": {"name": "Acme"}}, {"key": "bolt", "input": {"name": "Bolt"}}]})
    assert put.status_code == 200, put.text
    assert put.json()["data"]["keys"] == ["acme", "bolt"] and put.json()["data"]["num_examples"] == 2

    bad = await call_local("POST", f"{base}/put-rows", {"rows": [{"key": "core", "input": {"name": "Core"}}, {"key": "acme", "input": {"status": "maybe"}}]})
    assert bad.status_code == 400 and {d["path"].split(".")[0] for d in bad.json()["data"]["details"]} == {"acme"}
    stale = await call_local("POST", f"{base}/put-rows", {"rows": [{"key": "acme", "input": {"name": "A"}}], "expected": {"acme": "0" * 16}})
    assert stale.status_code == 409

    synced = await call_local("POST", f"{base}/sync-rows", {"rows": [{"key": "acme", "input": {"name": "Acme"}}, {"key": "dyne", "input": {"name": "Dyne"}}]})
    assert synced.json()["data"] == {"created": ["dyne"], "updated": [], "unchanged": ["acme"], "deleted": ["bolt"], "num_examples": 2}

    assert (await call_local("POST", f"{base}/delete-rows", {"keys": ["acme", "ghost"]})).status_code == 404
    gone = await call_local("POST", f"{base}/delete-rows", {"keys": ["acme", "dyne"]})
    assert gone.json()["data"] == {"keys": ["acme", "dyne"], "num_examples": 0}
    assert (await call_local("POST", f"{base}/delete-rows", {"keys": "acme"})).status_code == 400
