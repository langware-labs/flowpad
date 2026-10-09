"""Rules across rows (``rules`` in a record's data_schema.json): declared once, checked by Flowpad on
every write and read -- so no writer can skip them (found on GTM Studio: its tag chain lived in two
apps and a third writer broke it)."""
from __future__ import annotations

import json
import uuid

import pytest

pytestmark = pytest.mark.timeout(10)


def _schema(root, ns, kind, fields, rules=None):
    folder = root / "agentic-assets/data_schema" / kind
    folder.mkdir(parents=True)
    doc = {"type": "data_schema", "ns": ns, "fields": fields, **({"rules": rules} if rules else {})}
    (folder / "data_schema.json").write_text(json.dumps(doc))
    (folder / "description.md").write_text(f"A {kind}.")


def _dataset(root, name, kind):
    from flow_sdk.builtin.dataset import Dataset

    folder = root / "agentic-assets/dataset" / name
    folder.mkdir(parents=True)
    (folder / "dataset.json").write_text(json.dumps(
        {"metadata": {"title": name, "data_layout": "io_folder", "spec": {"examples": [{"input": kind}]}}, "data": {}}))
    return Dataset.at(folder)


F = lambda shape: {"shape": shape, "description": "x"}   # noqa: E731


@pytest.fixture
def gtm(tmp_path):
    """ICP › persona › use case; a deal tags any of them, a campaign lists use cases of ONE persona."""
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestrules" + uuid.uuid4().hex[:8]
    _schema(root, ns, "g.icp", {"name": F("string")})
    _schema(root, ns, "g.persona", {"name": F("string"), "icp": F("g.icp")})
    _schema(root, ns, "g.use_case", {"name": F("string"), "persona": F("g.persona")})
    _schema(root, ns, "g.deal", {"name": F("string"), "icp": F("?g.icp"), "persona": F("?g.persona"), "use_case": F("?g.use_case")},
            rules=[{"same": ["persona.icp", "icp"], "description": "the persona is one of the ICP's"},
                   {"same": ["use_case.persona", "persona"]},
                   {"same": ["use_case.persona.icp", "icp"]}])
    _schema(root, ns, "g.campaign", {"name": F("string"), "persona": F("g.persona"), "use_cases": F(["g.use_case"])},
            rules=[{"same": ["use_cases.*.persona", "persona"]}])
    errors = {str(k): v for k, v in load_root(root).items() if v}
    assert not errors, errors
    k = lambda name: f"--{ns}--.g.{name}"   # noqa: E731
    ds = {n: _dataset(root, n, k(n)) for n in ("icp", "persona", "use_case", "deal", "campaign")}
    return root, ns, ds


async def _seed(ds):
    await ds["icp"].append([{"key": "a", "input": {"name": "A"}}, {"key": "b", "input": {"name": "B"}}])
    ref = lambda n, key: next(ds[n].ref_of(r.id) for r in ds[n].read_rows() if r.key == key)   # noqa: E731
    await ds["persona"].append([{"key": "pa", "input": {"name": "PA", "icp": ref("icp", "a")}},
                                {"key": "pb", "input": {"name": "PB", "icp": ref("icp", "b")}}])
    await ds["use_case"].append([{"key": "ua", "input": {"name": "UA", "persona": ref("persona", "pa")}}])
    return ref


async def test_a_deal_that_breaks_the_chain_is_refused_with_the_rule_named(gtm):
    from flow_sdk.builtin.dataset import LinkError

    _, _, ds = gtm
    ref = await _seed(ds)
    bad = {"input": {"name": "D", "icp": ref("icp", "b"), "persona": ref("persona", "pa")}}
    (detail,) = ds["deal"].check_details(bad)
    assert detail["code"] == "rule" and detail["path"] == "input.persona.icp" and "one of the ICP's" in detail["message"]
    with pytest.raises(LinkError):
        await ds["deal"].put("d", bad)


async def test_a_skipped_level_is_still_checked_and_an_empty_hop_skips(gtm):
    _, _, ds = gtm
    ref = await _seed(ds)
    skip = {"input": {"name": "D", "icp": ref("icp", "b"), "use_case": ref("use_case", "ua")}}   # no persona
    assert [d["path"] for d in ds["deal"].check_details(skip)] == ["input.use_case.persona.icp"]
    assert ds["deal"].check({"input": {"name": "D", "icp": ref("icp", "a"), "use_case": ref("use_case", "ua")}}) == []
    assert ds["deal"].check({"input": {"name": "D", "icp": ref("icp", "b")}}) == []


async def test_a_list_path_checks_every_element(gtm):
    _, _, ds = gtm
    ref = await _seed(ds)
    ok = {"input": {"name": "C", "persona": ref("persona", "pa"), "use_cases": [ref("use_case", "ua")]}}
    assert ds["campaign"].check(ok) == []
    bad = {"input": {**ok["input"], "persona": ref("persona", "pb")}}
    assert [d["code"] for d in ds["campaign"].check_details(bad)] == ["rule"]


async def test_editing_a_parent_that_would_break_a_row_below_it_is_refused(gtm):
    from flow_sdk.builtin.dataset import LinkError

    _, _, ds = gtm
    ref = await _seed(ds)
    await ds["deal"].put("d", {"input": {"name": "D", "icp": ref("icp", "a"), "use_case": ref("use_case", "ua")}})
    (uc,) = ds["use_case"].read_rows()
    with pytest.raises(LinkError, match="would break .*g.deal d"):
        await ds["use_case"].put("ua", {"input": {"name": "UA", "persona": ref("persona", "pb")}}, expected=uc.version)
    await ds["use_case"].put("ua", {"input": {"name": "UA renamed", "persona": ref("persona", "pa")}}, expected=uc.version)


async def test_a_row_written_by_hand_that_breaks_a_rule_is_reported_on_read(gtm):
    root, _, ds = gtm
    ref = await _seed(ds)
    await ds["deal"].put("d", {"input": {"name": "D", "icp": ref("icp", "a"), "persona": ref("persona", "pa")}})
    doc = next((root / "agentic-assets/dataset/deal/examples/d/input").glob("*.json"))
    doc.write_text(doc.read_text().replace(ref("icp", "a"), ref("icp", "b")))      # a writer that skips the SDK
    rows, (problem,) = ds["deal"].rows_and_problems()
    assert rows == [] and problem["details"][0]["code"] == "rule"


async def test_a_shape_error_and_a_broken_link_come_back_in_one_answer(gtm):
    _, ns, ds = gtm
    await _seed(ds)
    gone = f"--{ns}--.g.icp.id.{uuid.uuid4()}"
    codes = {d["code"] for d in ds["persona"].check_details({"input": {"name": 7, "icp": gone}})}
    assert codes == {"shape:string_type", "dangling_ref"}


def test_a_rule_path_that_walks_no_link_is_refused_at_apply(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns = tmp_path / "proj", "unittestrules" + uuid.uuid4().hex[:8]
    _schema(root, ns, "g.icp", {"name": F("string")})
    _schema(root, ns, "g.deal", {"name": F("string"), "icp": F("?g.icp")}, rules=[{"same": ["name.icp", "icp"]}])
    errors = {k.name: v for k, v in load_root(root).items() if v}
    assert "is not a link to a row" in errors["g.deal"]


async def test_a_kind_check_with_the_project_checks_links_and_rules_too(gtm, monkeypatch):
    from flow_sdk.server.routes import kinds

    root, ns, ds = gtm
    ref = await _seed(ds)
    async def project_root(_project):
        return root
    monkeypatch.setattr(kinds, "_project_root", project_root)
    bad = {"name": "D", "icp": ref("icp", "b"), "persona": ref("persona", "pa")}
    shape_only = (await kinds.check_kind(f"--{ns}--.g.deal", {"value": bad})).data
    assert shape_only["ok"] and shape_only["links_checked"] is False
    full = (await kinds.check_kind(f"--{ns}--.g.deal", {"value": bad}, project="p")).data
    assert not full["ok"] and full["links_checked"] and [d["code"] for d in full["details"]] == ["rule"]
    gone = {"name": "P", "icp": f"--{ns}--.g.icp.id.{uuid.uuid4()}"}
    assert [d["code"] for d in (await kinds.check_kind(f"--{ns}--.g.persona", {"value": gone}, project="p")).data["details"]] == ["dangling_ref"]


async def test_bare_kinds_and_rows_by_reference(gtm, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.schema.data_spec.declared import kind_in
    from flow_sdk.server.routes import kinds

    root, ns, ds = gtm
    ref = await _seed(ds)
    assert kind_in(root, "g.persona") == f"--{ns}--.g.persona" and kind_in(root, "g.nothing") is None
    (found,) = Dataset.for_kind("g.persona", root)                      # a bare kind, resolved in the project
    assert found.id == ds["persona"].id
    dataset, key = Dataset.find_row(ref("persona", "pb"), root)
    assert (dataset.id, key) == (ds["persona"].id, "pb")
    async def project_root(_project):
        return root
    monkeypatch.setattr(kinds, "_project_root", project_root)
    assert (await kinds.resolve_kind("g.persona", project="p")).data == {"kind": f"--{ns}--.g.persona"}
    got = (await kinds.row_by_ref(ref("persona", "pb"), project="p")).data
    assert got["key"] == "pb" and got["row"]["input"]["name"] == "PB"
    assert (await kinds.row_by_ref(f"--{ns}--.g.persona.id.{uuid.uuid4()}", project="p")).status_code == 404


def test_flow_instance_python_prints_the_interpreter_flow_runs_on():
    import sys

    from typer.testing import CliRunner

    from flow_sdk.cli.commands.instance_cmd import instance_app

    out = CliRunner().invoke(instance_app, ["python"])
    assert out.exit_code == 0 and out.output.strip() == sys.executable


def test_a_kinds_form_lists_its_rules(gtm):
    from flow_sdk.server.routes.kinds import kind_form

    _, ns, _ = gtm
    form = kind_form(f"--{ns}--.g.deal")
    assert form["rules"][0] == {"same": ["persona.icp", "icp"], "description": "the persona is one of the ICP's"}
    assert kind_form(f"--{ns}--.g.icp")["rules"] == []


async def test_a_refusal_on_409_names_its_code(gtm):
    from flow_sdk.builtin.dataset import ConflictError, LinkError

    _, _, ds = gtm
    ref = await _seed(ds)
    with pytest.raises(ConflictError) as changed:
        await ds["icp"].put("a", {"input": {"name": "A2"}}, expected="0" * 16)
    with pytest.raises(ConflictError) as gone:
        await ds["icp"].put("nobody", {"input": {"name": "N"}}, expected="0" * 16)
    with pytest.raises(LinkError) as referenced:
        ds["icp"].delete_row("a")                                          # persona pa points at it
    assert [e.value.details[0]["code"] for e in (changed, gone, referenced)] == ["conflict", "gone", "referenced"]
    assert ref("icp", "a")
