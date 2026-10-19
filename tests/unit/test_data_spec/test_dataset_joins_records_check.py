"""Three questions a real walk of data paths could not ask in one call:

* a JOIN on a value that is not a link -- "people who replied AND have a meeting" -- as a sub-query;
* a path that continues INTO a linked record (an ingested email's fields);
* ``check`` meaning exactly "a put of this row would pass".
"""

from __future__ import annotations

import json
import uuid

import pytest

from tests.unit.test_data_spec import test_row_links
from tests.unit.test_data_spec.test_row_links import _dataset, _schema

crm = test_row_links.crm

pytestmark = pytest.mark.timeout(5)


def _touches(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestjoin" + uuid.uuid4().hex[:8]
    _schema(root, ns, "crm.touch", {"metric": {"shape": "string", "description": "x"}, "email": {"shape": "?string", "description": "x"},
                                    "day": {"shape": "?date", "description": "x"},
                                    "mail": {"shape": "?ingest.source_item", "description": "The email it was counted from."}})
    _schema(root, ns, "crm.person", {"email": {"shape": "string", "description": "x"}, "vip": {"shape": "bool", "description": "x"}})
    assert not any(load_root(root).values())
    return root, ns, _dataset(root, "touches", f"--{ns}--.crm.touch"), _dataset(root, "people", f"--{ns}--.crm.person")


async def _filled(tmp_path):
    root, ns, touches, people = _touches(tmp_path)
    rows = [("r1", "reply", "a@x.io", "2026-09-01"), ("r2", "reply", "b@x.io", "2026-09-02"), ("r3", "reply", "c@x.io", "2026-09-03"),
            ("m1", "meeting", "a@x.io", "2026-09-05"), ("m2", "meeting", "d@x.io", "2026-09-06"), ("m3", "meeting", "c@x.io", "2026-09-07"),
            ("s1", "sent", "e@x.io", "2026-09-01")]
    await touches.put_many([{"key": k, "input": {"metric": m, "email": e, "day": d}} for k, m, e, d in rows])
    await people.put_many([{"key": "a", "input": {"email": "a@x.io", "vip": True}}, {"key": "c", "input": {"email": "c@x.io", "vip": False}},
                           {"key": "d", "input": {"email": "d@x.io", "vip": True}}])
    return root, ns, touches, people


def _keys(found):
    return sorted(r["key"] for r in found["rows"])


def _among(path, match, of=None):
    return {"op": "$PROP", "operands": [path, match] + ([of] if of else [])}


async def test_a_join_on_a_value_that_is_not_a_link_is_one_question(tmp_path):
    _, _, touches, _ = await _filled(tmp_path)
    replied = _among("input.email", {"input.metric": "reply"})
    met = {"op": "$AND", "operands": [{"input.metric": "meeting"}, {"op": "$IN", "operands": ["input.email", replied]}]}
    assert _keys(touches.query(met)) == ["m1", "m3"]                           # the meetings of people who replied
    assert touches.count(met, metrics={"people": "distinct:input.email"})["metrics"] == {"people": 2}
    silent = {"op": "$AND", "operands": [{"input.metric": "meeting"}, {"op": "$NIN", "operands": ["input.email", replied]}]}
    assert _keys(touches.query(silent)) == ["m2"]                              # ... and of people who never did


async def test_a_sub_query_may_ask_another_kinds_rows_and_nest(tmp_path):
    _, ns, touches, _ = await _filled(tmp_path)
    vips = _among("input.email", {"input.vip": True}, f"--{ns}--.crm.person")
    assert _keys(touches.query({"op": "$IN", "operands": ["input.email", vips]})) == ["m1", "m2", "r1"]
    assert _keys(touches.query({"op": "$IN", "operands": ["input.email", _among("input.email", {"input.vip": True}, "crm.person")]})) == ["m1", "m2", "r1"]   # a bare kind of the project
    vips_who_replied = _among("input.email", {"op": "$AND", "operands": [{"input.metric": "reply"}, {"op": "$IN", "operands": ["input.email", vips]}]})
    assert _keys(touches.query({"op": "$AND", "operands": [{"input.metric": "meeting"}, {"op": "$IN", "operands": ["input.email", vips_who_replied]}]})) == ["m1"]
    everyone = _among("input.email", {})                                       # an empty match: every row
    assert touches.query({"op": "$IN", "operands": ["input.email", everyone]})["total"] == 7


async def test_a_sub_query_that_cannot_be_asked_is_refused(tmp_path):
    _, _, touches, _ = await _filled(tmp_path)
    with pytest.raises(ValueError, match="expected one dataset of 'crm.nobody'"):
        touches.query({"op": "$IN", "operands": ["input.email", _among("input.email", {}, "crm.nobody")]})
    with pytest.raises(ValueError, match="a sub-query is"):
        touches.query({"op": "$IN", "operands": ["input.email", {"op": "$PROP", "operands": ["input.email", "not a match"]}]})


async def test_the_older_prop_form_still_means_a_list_field_of_this_row(crm):
    _, _, leads = crm
    await leads.put("dana", {"input": {"name": "Dana", "past": [], "notes": [{"text": "x"}]}})
    assert leads.query({"op": "$IN", "operands": ["Dana", {"op": "$PROP", "operands": ["input.name"]}]})["total"] == 1


async def test_a_path_continues_into_a_record_the_caller_read(tmp_path):
    _, _, touches, _ = await _filled(tmp_path)
    ref = lambda n: f"ingest.source_item.id.0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b{n:02d}"   # noqa: E731
    await touches.put("r1", {"input": {"metric": "reply", "email": "a@x.io", "mail": ref(1)}})
    await touches.put("r2", {"input": {"metric": "reply", "email": "b@x.io", "mail": ref(2)}})
    records = {ref(1): {"name": "Re: pricing", "author_display": "Ann", "thread_key": "t1"},
               ref(2): {"name": "Out of office", "author_display": "Bob", "thread_key": "t2"}}
    assert _keys(touches.query({"op": "$LIKE", "operands": ["input.mail.name", "pricing"]}, records=records)) == ["r1"]
    assert touches.query({"input.mail.name": "Re: pricing"})["total"] == 0                    # without them: the path is null
    got = touches.count({"op": "$IS_NOT_NULL", "operands": ["input.mail"]}, group_by=["input.mail.author_display"], records=records)
    assert {g["by"]["input.mail.author_display"]: g["count"] for g in got["groups"]} == {"Ann": 1, "Bob": 1}
    page = touches.query({"key": "r1"}, expand=["input.mail"], records=records)
    assert page["linked"] == {ref(1): {"type": "source_item", "id": ref(1).rsplit(".", 1)[1], "record": records[ref(1)]}}
    assert page["rows"][0]["input"]["mail"] == ref(1)


async def test_the_read_actions_fetch_the_records_a_question_leads_to(tmp_path, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.core import Entity
    from tests.unit._graph_client import call_local

    root, ns, _, _ = _touches(tmp_path)
    ds = Dataset(id=str(uuid.uuid4()), name="touches-http", asset_ref=str(root / "agentic-assets/dataset/touches-http"),
                 data_layout="io_folder", spec={"rows": [{"input": f"--{ns}--.crm.touch"}]})
    await ds.save()
    item = "0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c"
    await ds.put_many([{"key": "r1", "input": {"metric": "reply", "mail": f"ingest.source_item.id.{item}"}}, {"key": "s1", "input": {"metric": "sent"}}])
    asked = []

    class Item:
        def model_dump(self, mode="json"):
            return {"name": "Re: pricing", "author_display": "Ann"}

    real = Entity.get_by_typeid

    async def get_by_typeid(typeid, *a, **k):
        if str(typeid).startswith("source_item-"):
            asked.append(str(typeid))
            return Item() if str(typeid).endswith(item) else None
        return await real(typeid, *a, **k)

    monkeypatch.setattr(Entity, "get_by_typeid", get_by_typeid)
    base = f"dataset/{ds.id}"
    got = (await call_local("GET", f"{base}/rows", params={"filter": json.dumps({"match": {"input.mail.author_display": "Ann"}, "expand": ["input.mail"]})})).json()["data"]
    assert [r["key"] for r in got["rows"]] == ["r1"] and list(got["linked"].values())[0]["record"]["name"] == "Re: pricing"
    assert asked == [f"source_item-{item}"]                                    # one record, read once
    counted = (await call_local("GET", f"{base}/count", params={"group_by": "input.mail.author_display"})).json()["data"]
    assert {g["by"]["input.mail.author_display"]: g["count"] for g in counted["groups"]} == {"Ann": 1, None: 1}
    asked.clear()
    assert (await call_local("GET", f"{base}/rows", params={"filter": json.dumps({"match": {"input.metric": "sent"}})})).json()["data"]["total"] == 1
    assert (await call_local("GET", f"{base}/rows")).json()["data"]["total"] == 2
    join = {"op": "$IN", "operands": ["input.metric", {"op": "$PROP", "operands": ["input.metric", {"key": "r1"}]}]}
    assert (await call_local("GET", f"{base}/rows", params={"filter": json.dumps({"match": join})})).json()["data"]["total"] == 1


# ── check means: a put of this row would pass ────────────────────────────────


async def test_check_of_a_keyed_row_is_what_put_would_do(crm):
    _, companies, leads = crm
    (acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    await leads.put("dana", {"input": {"name": "Dana", "company": companies.ref_of(acme), "past": [], "notes": []}})
    partial = {"key": "dana", "context": None}                                  # no `input`: not a row at all
    assert leads.check(partial)[0].startswith("row 1:")
    assert leads.check({"key": "dana", "input": {"name": "Dana L", "past": [], "notes": []}}) == []
    assert leads.check({"key": "new-one", "input": {"name": "New", "past": [], "notes": []}}) == []    # a key that is free
    assert "cannot be a row key" in leads.check({"key": "Bad Key", "input": {"name": "x", "past": [], "notes": []}})[0]
    assert leads.row("dana")["input"]["name"] == "Dana"                     # nothing was written


async def test_check_sees_the_rules_of_the_rows_that_reach_this_one(tmp_path):
    """A put that would break a rule of ANOTHER row is refused; ``check`` used to say it was fine."""
    from flow_sdk.builtin.dataset import LinkError
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestchk" + uuid.uuid4().hex[:8]
    f = lambda shape: {"shape": shape, "description": "x"}   # noqa: E731
    _schema(root, ns, "g.icp", {"name": f("string")})
    _schema(root, ns, "g.persona", {"name": f("string"), "icp": f("g.icp")})
    folder = root / "agentic-assets/data_schema/g.deal"
    folder.mkdir(parents=True)
    (folder / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns, "fields": {"name": f("string"), "icp": f("g.icp"), "persona": f("g.persona")},
                                                         "rules": [{"same": ["persona.icp", "icp"]}]}))
    (folder / "description.md").write_text("# g.deal\n")
    assert not any(load_root(root).values())
    icps, personas, deals = (_dataset(root, n, f"--{ns}--.g.{k}") for n, k in (("icps", "icp"), ("personas", "persona"), ("deals", "deal")))
    a, b = await icps.put_many([{"key": "a", "input": {"name": "A"}}, {"key": "b", "input": {"name": "B"}}])
    (p,) = await personas.put_many([{"key": "p", "input": {"name": "P", "icp": icps.ref_of(a)}}])
    await deals.put("d", {"input": {"name": "D", "icp": icps.ref_of(a), "persona": personas.ref_of(p)}})
    moved = {"key": "p", "input": {"name": "P", "icp": icps.ref_of(b)}}         # the persona moves to another ICP: the deal breaks
    with pytest.raises(LinkError, match="would break"):
        await personas.put("p", {"input": moved["input"]})
    answer = personas.check_row(moved)
    assert answer["ok"] is False and "would break" in answer["errors"][0] and answer["details"][0]["code"] == "rule"
    assert personas.check_row({"key": "p", "input": {"name": "P2", "icp": icps.ref_of(a)}})["ok"] is True
