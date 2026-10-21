"""A query path follows links; ``expand`` brings the linked rows back beside; ``used_by`` says who
links to a row; ``q`` reads a row's text. On the same real project tree as ``test_row_links``:
companies, and leads that link to a company (``company``), to several (``past``) and to a lead (``about``).
"""

from __future__ import annotations

import pytest

from tests.unit.test_data_spec import test_row_links

crm = test_row_links.crm

pytestmark = pytest.mark.timeout(5)


async def _filled(crm):
    root, companies, leads = crm
    acme, bolt, core = await companies.append([{"key": k, "input": {"name": n}} for k, n in [("acme", "Acme"), ("bolt", "Bolt"), ("core", "Core")]])
    ref = companies.ref_of
    (dana,) = await leads.append([{"key": "dana", "input": {"name": "Dana", "company": ref(acme), "past": [ref(bolt), ref(core)], "notes": []}}])
    await leads.append([
        {"key": "eli", "input": {"name": "Eli", "company": ref(acme), "past": [], "about": leads.ref_of(dana), "notes": []}},
        {"key": "fay", "input": {"name": "Fay", "company": ref(bolt), "past": [ref(acme)], "notes": []}},
        {"key": "gil", "input": {"name": "Gil", "past": [], "notes": []}}])
    return root, companies, leads


def _keys(found):
    return [r["key"] for r in found["rows"]]


async def test_a_path_follows_a_link_into_the_linked_row(crm):
    _, companies, leads = await _filled(crm)
    assert _keys(leads.query({"input.company.name": "Acme"}, order_by={"key": "asc"})) == ["dana", "eli"]
    assert _keys(leads.query({"input.company.key": "bolt"})) == ["fay"]                     # the linked row itself
    assert _keys(leads.query({"input.company.ref": companies.row("acme")["ref"]}, order_by={"key": "asc"})) == ["dana", "eli"]
    assert _keys(leads.query({"input.about.company.name": "Acme"})) == ["eli"]              # two links deep (a lead's lead's company)
    assert _keys(leads.query({"op": "$IS_NULL", "operands": ["input.company.name"]})) == ["gil"]   # no link: the path is null


async def test_a_path_over_a_list_of_links_matches_any_of_them(crm):
    _, _, leads = await _filled(crm)
    assert _keys(leads.query({"input.past.*.name": "Core"})) == ["dana"]
    assert _keys(leads.query({"op": "$IN", "operands": ["input.past.*.key", ["acme", "core"]]}, order_by={"key": "asc"})) == ["dana", "fay"]


async def test_order_and_group_by_what_a_link_leads_to(crm):
    _, _, leads = await _filled(crm)
    assert _keys(leads.query(order_by=[{"input.company.name": "desc"}, {"key": "asc"}])) == ["gil", "fay", "dana", "eli"]
    got = leads.count(group_by=["input.company.key"], order_by={"input.company.key": "asc"})
    assert [(g["by"]["input.company.key"], g["count"]) for g in got["groups"]] == [("acme", 2), ("bolt", 1), (None, 1)]
    per_past = leads.count(group_by=["input.past.*.name"], order_by={"input.past.*.name": "asc"})
    assert [(g["by"]["input.past.*.name"], g["count"]) for g in per_past["groups"]] == [("Acme", 1), ("Bolt", 1), ("Core", 1), (None, 2)]


async def test_a_string_that_only_looks_like_a_reference_is_not_followed(crm):
    _, companies, leads = await _filled(crm)
    ghost = companies.ref_of("0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")
    from flow_sdk.datasets.query import field_of
    assert field_of({"input": {"x": ghost}}, "input.x.name") is None                        # no follow given: never chased
    assert field_of({"input": {"x": ghost}}, "input.x.name", follow=lambda ref: None) is None   # names no row: null


async def test_each_linked_dataset_is_read_once_per_query(crm, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset

    _, _, leads = await _filled(crm)
    reads = []
    real = Dataset.read_lenient
    monkeypatch.setattr(Dataset, "read_lenient", lambda self: reads.append(self._folder().name) or real(self))
    leads.query({"input.company.name": "Acme"}, order_by={"input.company.name": "asc"}, expand=["input.company"])
    assert reads == ["companies"]                                                           # four leads, three paths: one read


async def test_expand_brings_the_linked_rows_back_beside_once_each(crm):
    _, companies, leads = await _filled(crm)
    got = leads.query(order_by={"key": "asc"}, expand=["input.company", "input.past.*"])
    refs = {k: companies.row(k)["ref"] for k in ("acme", "bolt", "core")}
    assert set(got["linked"]) == set(refs.values())
    one = got["linked"][refs["acme"]]
    assert (one["key"], one["dataset_id"], one["row"]["input"]["name"], one["row"]["ref"]) == ("acme", companies.id, "Acme", refs["acme"])
    assert got["rows"][0]["input"]["company"] == refs["acme"]                               # the row keeps its reference
    assert "linked" not in leads.query()
    page = leads.query(order_by={"key": "asc"}, limit=1, offset=3, expand=["input.company"])   # gil: no company
    assert page["linked"] == {}                                                             # only what the PAGE links to
    two = leads.query({"key": "eli"}, expand=["input.about", "input.about.company"])
    assert sorted(v["key"] for v in two["linked"].values()) == ["acme", "dana"]
    with pytest.raises(ValueError, match="expand"):
        leads.query(expand="input.company")


async def test_a_row_expanded_can_be_put_back_as_it_was_read(crm):
    _, _, leads = await _filled(crm)
    row = leads.query({"key": "dana"}, expand=["input.company"])["rows"][0]
    await leads.put("dana", {"input": row["input"]}, expected=row["version"])
    assert leads.row("dana")["version"] == row["version"]


async def test_used_by_says_who_links_to_each_row_and_who_to_none(crm):
    _, companies, leads = await _filled(crm)
    users = companies.used_by()
    assert {k: sorted(u["key"] for u in by) for k, by in users.items()} == {"acme": ["dana", "eli", "fay"], "bolt": ["dana", "fay"], "core": ["dana"]}
    assert users["core"] == [{"dataset_id": leads.id, "kind": leads.row_kind, "key": "dana"}]
    assert leads.used_by(["dana", "gil"]) == {"dana": [{"dataset_id": leads.id, "kind": leads.row_kind, "key": "eli"}], "gil": []}
    assert [k for k, by in leads.used_by().items() if not by] == ["eli", "fay", "gil"]      # the rows nothing uses
    with pytest.raises(LookupError, match="ghost"):
        companies.used_by(["acme", "ghost"])


async def test_a_delete_is_refused_for_exactly_what_used_by_says(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, companies, leads = await _filled(crm)
    with pytest.raises(LinkError) as refused:
        companies.delete_rows(["core"])
    assert str(refused.value) == f"used by {leads.row_kind} dana"
    assert [u["key"] for u in companies.used_by(["core"])["core"]] == ["dana"]


async def test_q_reads_every_text_of_a_row_and_joins_match(crm):
    _, _, leads = await _filled(crm)
    await leads.put("gil", {"input": {"name": "Gil Stone", "past": [], "notes": [{"text": "Asked about PRICING twice"}]}})
    assert _keys(leads.query(q="pricing")) == ["gil"]                                       # inside a list of values, any case
    assert _keys(leads.query(q="gil pricing")) == ["gil"]                                   # every word, each anywhere in the row
    assert _keys(leads.query(q="gil acme")) == []
    assert leads.count(q="pricing")["total"] == 1                                           # the number and the list: one question
    assert _keys(leads.query({"input.company.name": "Acme"}, q="eli")) == ["eli"]


async def test_the_read_actions_take_the_same_questions_over_http(crm):
    import json
    import uuid

    from flow_sdk.builtin.dataset import Dataset
    from tests.unit._graph_client import call_local

    root, companies, leads = await _filled(crm)
    served = {}
    for name, source in (("companies-http", companies), ("leads-http", leads)):
        ds = Dataset(id=str(uuid.uuid4()), name=name, asset_ref=str(root / "agentic-assets/dataset" / name),
                     data_layout="io_folder", spec={"rows": [{"input": source.row_kind}]})
        await ds.save()
        served[name] = ds
    co, le = served["companies-http"], served["leads-http"]
    (zed,) = await co.append([{"key": "zed", "input": {"name": "Zed"}}])
    await le.append([{"key": "hal", "input": {"name": "Hal", "company": co.ref_of(zed), "past": [], "notes": []}},
                     {"key": "ivy", "input": {"name": "Ivy", "past": [], "notes": []}}])
    base = f"dataset/{le.id}"
    got = (await call_local("GET", f"{base}/rows", params={"filter": json.dumps({"match": {"input.company.name": "Zed"}, "expand": ["input.company"]})})).json()["data"]
    assert [r["key"] for r in got["rows"]] == ["hal"] and [v["key"] for v in got["linked"].values()] == ["zed"]
    assert (await call_local("GET", f"{base}/rows", params={"q": "ivy"})).json()["data"]["total"] == 1
    counted = (await call_local("GET", f"{base}/count", params={
        "group_by": "input.company.key", "metrics": json.dumps({"names": "distinct:input.name"}),
        "order_by": json.dumps({"count": "desc"})})).json()["data"]
    assert counted["metrics"] == {"names": 2} and {g["by"]["input.company.key"] for g in counted["groups"]} == {"zed", None}
    assert (await call_local("GET", f"{base}/count", params={"group_by": "fortnight:input.name"})).status_code == 400
    users = (await call_local("GET", f"dataset/{co.id}/used-by")).json()["data"]["used_by"]
    assert users == {"zed": [{"dataset_id": le.id, "kind": le.row_kind, "key": "hal"}]}
    assert (await call_local("GET", f"dataset/{co.id}/used-by", params={"keys": "ghost"})).status_code == 404


# ── step 0: one shape for a refusal, one read, one import home ───────────────


async def test_every_refused_write_answers_lines_and_details(crm):
    import uuid

    from flow_sdk.builtin.dataset import Dataset
    from tests.unit._graph_client import call_local

    root, companies, _ = crm
    ds = Dataset(id=str(uuid.uuid4()), name="co-http", asset_ref=str(root / "agentic-assets/dataset/co-http"),
                 data_layout="io_folder", spec={"rows": [{"input": companies.row_kind}]})
    await ds.save()
    base, bad = f"dataset/{ds.id}", {"input": {"name": 7}}
    for action, body in (("append", {"rows": [bad]}), ("put-row", {"key": "x", "row": bad}), ("put-rows", {"rows": [{"key": "x", **bad}]})):
        data = (await call_local("POST", f"{base}/{action}", body)).json()["data"]
        assert all(isinstance(line, str) for line in data["errors"]) and data["errors"], action
        assert data["details"][0]["code"].startswith("shape:") and data["details"][0]["path"].endswith("input.name"), action
    ok = (await call_local("POST", f"{base}/put-row", {"key": "x", "row": {"input": {"name": "X"}}})).json()["data"]
    assert ok["id"] == ok["row_id"]                                                     # `id` is the name; the old one stays


async def test_rows_is_the_read_and_check_row_the_answer_typescript_gets(crm):
    _, companies, _ = crm
    await companies.put("acme", {"input": {"name": "Acme"}})
    assert companies.query({"key": "acme"})["total"]
    assert companies.check_row({"input": {"name": "Ok"}}) == {"ok": True, "errors": [], "details": []}
    bad = companies.check_row({"input": {"name": 7}})
    assert bad["ok"] is False and bad["errors"][0].startswith("input.name:") and bad["details"][0]["path"] == "input.name"


def test_one_import_home():
    import flow_sdk.datasets as home
    from flow_sdk.builtin.dataset import Dataset, LinkError, RowRefused

    assert home.Dataset is Dataset and home.RowRefused is RowRefused is LinkError
    assert callable(home.load_root) and callable(home.single_run) and callable(home.three_way) and callable(home.kind_form)
    with pytest.raises(AttributeError):
        home.nothing_here


async def test_labelling_a_row_is_a_write_like_any_other(tmp_path, monkeypatch):
    from flow_sdk.tags import ws_forward
    from flow_sdk.tags.bus import on_tag
    from tests.unit.test_data_spec.test_dataset_rows_by_key import _dataset as plain

    monkeypatch.setattr(ws_forward, "_started", True)
    heard = []
    off = on_tag("dataset.rows.changed", heard.append)
    try:
        d = plain(tmp_path)
        (rid,) = await d.append([{"key": "acme", "input": {"name": "Acme"}}])
        heard.clear()
        await d.annotate(rid, {"value": 3})
        d.set_data("acme", {"suite": "smoke"})
    finally:
        off()
    assert [(e.data["op"], e.data["keys"]) for e in heard] == [("put", ["acme"]), ("put", ["acme"])]
