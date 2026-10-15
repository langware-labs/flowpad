"""Three things a record schema says so that EVERY writer keeps them -- not only the app that knows:

* ``owned_by`` on a field: the value is a copy of an outside system's; only a writer that writes as
  that owner (``by=``) sets or changes it.
* ``{"unique": [...]}`` in ``rules``: no two rows of a dataset share the value(s).
* ``include``: another record's fields, rules and owners are this one's too -- defined once.

On a real project tree (schemas registered with ``load_root``), as a script and the server see it.
"""

from __future__ import annotations

import json
import uuid

import pytest

from tests.unit.test_data_spec.test_row_links import _dataset

pytestmark = pytest.mark.timeout(5)


def _schema(root, ns, kind, fields=None, **more):
    folder = root / "agentic-assets/data_schema" / kind
    folder.mkdir(parents=True, exist_ok=True)
    doc = {"type": "data_schema", "ns": ns, **({"fields": fields} if fields is not None else {}), **more}
    (folder / "data_schema.json").write_text(json.dumps(doc))
    (folder / "description.md").write_text(f"# {kind}\n")
    return folder


def _f(shape, **more):
    return {"shape": shape, "description": "x", **more}


@pytest.fixture
def proj(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestsoui" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.synced", {"crm_id": _f("?string", owned_by="crm"), "updated": _f("?date", owned_by="crm")},
            rules=[{"unique": ["crm_id"], "description": "one row per CRM record"}])
    _schema(root, ns, "crm.deal", {"name": _f("string", owned_by="crm"), "stage": _f("enum:open|won|lost", owned_by="crm"),
                                    "notes": _f("?string"), "region": _f("?string"), "code": _f("?string")},
            include=["crm.synced"], rules=[{"unique": ["region", "code"]}])
    errors = {str(k): v for k, v in load_root(root).items() if v}
    assert not errors, errors
    return root, ns, _dataset(root, "deals", f"--{ns}--.crm.deal")


def _deal(name="Acme", stage="open", **more):
    return {"input": {"name": name, "stage": stage, **more}}


def _codes(exc):
    return sorted((d["path"], d["code"]) for d in exc.value.details)


# ── include ──────────────────────────────────────────────────────────────────


def test_an_included_records_fields_rules_and_owners_are_this_ones_too(proj):
    from flow_sdk.server.routes.kinds import kind_form

    _, ns, deals = proj
    form = kind_form(f"--{ns}--.crm.deal")
    assert list(form["fields"]) == ["crm_id", "updated", "name", "stage", "notes", "region", "code"]   # the included ones first
    assert form["fields"]["crm_id"] == {"shape": "?string", "description": "x", "required": False, "owned_by": "crm"}
    assert "owned_by" not in form["fields"]["notes"]
    assert form["rules"] == [{"unique": ["crm_id"], "description": "one row per CRM record"}, {"unique": ["region", "code"], "description": ""}]


def test_include_refuses_what_it_cannot_mean(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestsoui" + uuid.uuid4().hex[:8]
    _schema(root, ns, "a.base", {"owner": _f("?string")})
    twice = _schema(root, ns, "a.twice", {"owner": _f("?string")}, include=["a.base"])
    ghost = _schema(root, ns, "a.ghost", {"x": _f("?string")}, include=["a.nobody"])
    me = _schema(root, ns, "a.me", {"x": _f("?string")}, include=["a.me"])
    only = _schema(root, ns, "a.only", include=["a.base"])                    # no field of its own: still a record
    errors = load_root(root)
    assert "defined here and by the included 'a.base'" in errors[twice]
    assert "no record kind of that name" in errors[ghost]
    assert "include each other" in errors[me]
    assert errors[only] == ""


def test_changing_an_included_record_changes_the_ones_that_include_it(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root
    from flow_sdk.server.routes.kinds import kind_form

    root, ns = tmp_path / "proj", "unittestsoui" + uuid.uuid4().hex[:8]
    _schema(root, ns, "a.base", {"owner": _f("?string")})
    _schema(root, ns, "a.task", {"title": _f("string")}, include=["a.base"])
    assert not any(load_root(root).values())
    assert list(kind_form(f"--{ns}--.a.task")["fields"]) == ["owner", "title"]
    _schema(root, ns, "a.base", {"owner": _f("?string"), "status": _f("?string")})
    assert not any(load_root(root).values())
    assert list(kind_form(f"--{ns}--.a.task")["fields"]) == ["owner", "status", "title"]


# ── owned_by ─────────────────────────────────────────────────────────────────


async def test_only_its_owner_sets_or_changes_an_owned_field(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    with pytest.raises(LinkError) as refused:                                  # the app may not create the CRM's deal
        await deals.put("acme", _deal(crm_id="c1"))
    assert _codes(refused) == [("input.crm_id", "owned"), ("input.name", "owned"), ("input.stage", "owned")]
    assert refused.value.details[0]["owned_by"] == "crm"
    await deals.put("acme", _deal(crm_id="c1"), by="crm")                      # the sync, writing as the CRM
    await deals.put("acme", {"input": {**_deal(crm_id="c1")["input"], "notes": "call back"}})   # its own field: free
    with pytest.raises(LinkError) as refused:
        await deals.put("acme", {"input": {**_deal(stage="won", crm_id="c1")["input"], "notes": "call back"}})
    assert _codes(refused) == [("input.stage", "owned")]
    with pytest.raises(LinkError):
        await deals.put("acme", _deal(stage="won", crm_id="c1"), by="erp")     # another system is not the owner either
    row = deals.row("acme")["input"]
    assert (row["stage"], row["notes"]) == ("open", "call back")
    await deals.put("acme", {"input": {**row, "stage": "won"}}, by="crm")
    assert deals.row("acme")["input"]["stage"] == "won"


async def test_owned_fields_in_bulk_writes_and_checks(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    rows = [{"key": "a", **_deal("A", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c2")}]
    for write in (deals.put_many, deals.sync, deals.append):
        with pytest.raises(LinkError) as refused:
            await write(rows)
        assert {d["code"] for d in refused.value.details} == {"owned"} and {d["path"].split(".")[0] for d in refused.value.details} == {"a", "b"}
    assert deals.read_rows() == []
    assert (await deals.sync(rows, by="crm"))["created"] == ["a", "b"]
    assert deals.check({"key": "a", **_deal("A", crm_id="c1", notes="n")}) == []            # a put of the same owned values
    assert deals.check({"key": "a", **_deal("A2", crm_id="c1")})[0].startswith("input.name: name is owned by crm")
    assert deals.check({"key": "a", **_deal("A2", crm_id="c1")}, by="crm") == []
    assert (await deals.sync(rows, by="crm"))["unchanged"] == ["a", "b"]


# ── unique ───────────────────────────────────────────────────────────────────


async def test_no_two_rows_share_a_unique_value(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    await deals.put("a", _deal("A", crm_id="c1"), by="crm")
    with pytest.raises(LinkError) as refused:
        await deals.put("b", _deal("B", crm_id="c1"), by="crm")
    assert _codes(refused) == [("input.crm_id", "unique")] and "already row 'a'" in str(refused.value)
    await deals.put("b", _deal("B"), by="crm")                                 # no value: not judged
    await deals.put("c", _deal("C"), by="crm")
    await deals.put("a", _deal("A1", crm_id="c1"), by="crm")                   # a row keeps its own value
    assert deals.check({"input": _deal("X", crm_id="c1")["input"]}, by="crm") == ["input.crm_id: rule: crm_id='c1' is already row 'a' (one row per CRM record)"]
    assert deals.check({"key": "a", **_deal("A1", crm_id="c1")}, by="crm") == []


async def test_a_unique_rule_over_several_fields_is_about_the_combination(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    await deals.put("a", _deal("A", region="eu", code="1"), by="crm")
    await deals.put("b", _deal("B", region="eu", code="2"), by="crm")
    await deals.put("c", _deal("C", region="us", code="1"), by="crm")
    await deals.put("d", _deal("D", region="eu"), by="crm")                    # one of them empty: not judged
    with pytest.raises(LinkError, match="region='eu', code='1' is already row 'a'"):
        await deals.put("e", _deal("E", region="eu", code="1"), by="crm")


async def test_unique_within_one_call(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    with pytest.raises(LinkError) as refused:                                  # two rows of ONE call
        await deals.put_many([{"key": "a", **_deal("A", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c1")}], by="crm")
    assert _codes(refused) == [("b.input.crm_id", "unique")] and deals.read_rows() == []
    with pytest.raises(LinkError):
        await deals.append([_deal("A", crm_id="c1"), _deal("B", crm_id="c1")], by="crm")


async def test_a_swap_of_unique_values_is_refused_and_a_pruned_row_frees_its_value(proj):
    from flow_sdk.builtin.dataset import LinkError

    _, _, deals = proj
    await deals.sync([{"key": "a", **_deal("A", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c2")}], by="crm")
    with pytest.raises(LinkError):
        await deals.put_many([{"key": "a", **_deal("A", crm_id="c2")}, {"key": "b", **_deal("B", crm_id="c1")}], by="crm")
    assert {r.key: r.input.crm_id for r in deals.read_rows()} == {"a": "c1", "b": "c2"}
    done = await deals.sync([{"key": "z", **_deal("Z", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c2")}], by="crm")
    assert (done["created"], done["deleted"]) == (["z"], ["a"])                # `a` goes in this sync: `z` takes c1 over


async def test_a_duplicate_that_reached_the_disk_is_reported_not_hidden(proj):
    root, _, deals = proj
    await deals.sync([{"key": "a", **_deal("A", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c2")}], by="crm")
    doc = next((root / "agentic-assets/dataset/deals/rows/b/input").glob("*.json"))
    doc.write_text(doc.read_text().replace('"c2"', '"c1"'))                    # a hand edit, a git pull
    rows, problems = deals.rows_and_problems()
    assert [r.key for r in rows] == ["a"]                                      # the first by key keeps the value
    assert [(p["key"], p["details"][0]["code"], p["input"]["crm_id"]) for p in problems] == [("b", "unique", "c1")]
    await deals.put("b", _deal("B", crm_id="c2"), by="crm", expected=problems[0]["version"])     # repaired
    assert deals.rows_and_problems()[1] == []


def test_a_unique_rule_must_name_single_valued_fields_of_the_record(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestsoui" + uuid.uuid4().hex[:8]
    ghost = _schema(root, ns, "u.ghost", {"a": _f("?string")}, rules=[{"unique": ["b"]}])
    many = _schema(root, ns, "u.many", {"tags": _f(["string"])}, rules=[{"unique": ["tags"]}])
    both = _schema(root, ns, "u.both", {"a": _f("?string")}, rules=[{"unique": ["a"], "same": ["a", "a"]}])
    errors = load_root(root)
    assert "no field 'b' here" in errors[ghost] and "holds several values" in errors[many]
    assert "one of" in errors[both]


# ── over HTTP ────────────────────────────────────────────────────────────────


async def test_owned_and_unique_over_http(proj):
    from flow_sdk.builtin.dataset import Dataset
    from tests.unit._graph_client import call_local

    root, ns, _ = proj
    deals = Dataset(id=str(uuid.uuid4()), name="deals-http", asset_ref=str(root / "agentic-assets/dataset/deals-http"),
                    data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.deal"}]})
    await deals.save()
    base = f"dataset/{deals.id}"
    refused = await call_local("POST", f"{base}/put-row", {"key": "a", "row": _deal("A", crm_id="c1")})
    assert refused.status_code == 400 and {d["code"] for d in refused.json()["data"]["details"]} == {"owned"}
    ok = await call_local("POST", f"{base}/put-row", {"key": "a", "row": _deal("A", crm_id="c1"), "by": "crm"})
    assert ok.status_code == 200, ok.text
    dup = await call_local("POST", f"{base}/put-rows", {"rows": [{"key": "b", **_deal("B", crm_id="c1")}], "by": "crm"})
    assert dup.status_code == 400 and dup.json()["data"]["details"][0]["code"] == "unique"
    synced = await call_local("POST", f"{base}/sync-rows", {"rows": [{"key": "a", **_deal("A", crm_id="c1")}, {"key": "b", **_deal("B", crm_id="c2")}], "by": "crm"})
    assert synced.json()["data"]["created"] == ["b"]
    check = (await call_local("POST", f"{base}/check-row", {"row": {"key": "a", **_deal("A9", crm_id="c1")}})).json()["data"]
    assert check["ok"] is False and check["details"][0]["code"] == "owned"
