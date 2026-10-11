"""Links between dataset rows: a field typed by a kind holds a REFERENCE to one row of it,
``<kind>.id.<uuid>`` -- the instance form ``value_ref`` already defines. The row's id is stored in the
row (``example.json`` ``metadata.id``), so a reference survives a rename and a re-clone, and the
dataset checks every reference on the way in and refuses a delete that would leave one dangling.

Built on a real project tree: data_schema folders registered with ``load_root``, two datasets side by
side, the same path a script (crm_sync) and the server take.
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.schema.data_spec.value_ref import ref_of

pytestmark = pytest.mark.timeout(5)

def _schema(root, ns, kind, fields):
    folder = root / "agentic-assets/data_schema" / kind
    folder.mkdir(parents=True)
    (folder / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns, "fields": fields}))
    (folder / "description.md").write_text(f"# {kind}\n")


def _dataset(root, name, kind):
    from flow_sdk.builtin.dataset import Dataset

    folder = root / "agentic-assets/dataset" / name
    folder.mkdir(parents=True)
    (folder / "dataset.json").write_text(json.dumps(
        {"metadata": {"data_layout": "io_folder", "spec": {"examples": [{"input": kind}]}}, "data": {}}))
    return Dataset.at(folder)


@pytest.fixture
def crm(tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root = tmp_path / "proj"
    ns = "unittestlinks" + uuid.uuid4().hex[:8]   # kinds are process-wide: one namespace per test
    _schema(root, ns, "crm.company", {"name": {"shape": "string", "description": "The company."}})
    _schema(root, ns, "crm.note", {"text": {"shape": "string", "description": "One line."}})
    _schema(root, ns, "crm.lead", {
        "name": {"shape": "string", "description": "The person."},
        "company": {"shape": "?crm.company", "description": "Where they work."},
        "past": {"shape": ["crm.company"], "description": "Where they worked."},
        "about": {"shape": "?crm.company|crm.lead", "description": "Who referred them: a company or a lead."},
        "notes": {"shape": ["crm.note"], "description": "Notes, as values."},
    })
    errors = {str(k): v for k, v in load_root(root).items() if v}
    assert not errors, errors
    return root, _dataset(root, "companies", f"--{ns}--.crm.company"), _dataset(root, "leads", f"--{ns}--.crm.lead")


async def test_a_row_stores_its_id_and_keeps_it_through_a_rename_and_a_new_dataset_id(crm):
    from flow_sdk.builtin.dataset import Dataset

    root, companies, _ = crm
    (acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    stored = json.loads((root / "agentic-assets/dataset/companies/examples/acme/example.json").read_text())
    assert stored["metadata"]["id"] == acme
    assert companies.rename_row("acme", "acme_inc") == acme
    # A fresh clone has no .flow capsule: the dataset gets a new id, the row keeps its own.
    again = Dataset.at(root / "agentic-assets/dataset/companies").model_copy(update={"id": "9b1f9a51-5c3e-4c11-8e0a-6c0b9b3f2a10"})
    assert [r.id for r in again.read_rows()] == [acme]
    assert companies.ref_of(acme) == ref_of(companies.row_kind, acme)


async def test_a_row_written_before_ids_were_stored_adopts_its_legacy_id(crm):
    from flow_sdk.schema.data_spec.layout import example_id

    root, companies, _ = crm
    folder = root / "agentic-assets/dataset/companies/examples/old"
    (folder / "input").mkdir(parents=True)
    (folder / "input/company.json").write_text('{"name": "Old Co"}')
    (folder / "example.json").write_text('{"metadata": {"kind": "train"}, "data": {}}')
    legacy = example_id(companies.id, "old")
    assert [r.id for r in companies.read_rows()] == [legacy]
    await companies.put("old", {"input": {"name": "Old Co Ltd"}})
    assert json.loads((folder / "example.json").read_text())["metadata"]["id"] == legacy   # adopted, stored


async def test_links_by_reference_are_checked_written_inline_and_read_back(crm):
    root, companies, leads = crm
    acme, beta = await companies.append([{"key": "acme", "input": {"name": "Acme"}}, {"key": "beta", "input": {"name": "Beta"}}])
    ref_acme, ref_beta = companies.ref_of(acme), companies.ref_of(beta)
    await leads.append([{"key": "dana", "input": {
        "name": "Dana", "company": ref_acme, "past": [ref_beta, ref_acme], "about": ref_beta,
        "notes": [{"text": "met at a meetup"}]}}])
    lead_dir = root / "agentic-assets/dataset/leads/examples/dana"
    doc = json.loads((lead_dir / "input/lead.json").read_text())
    assert doc["company"] == ref_acme and doc["past"] == [ref_beta, ref_acme]      # references: inline
    assert (lead_dir / "input/notes/0001/note.json").is_file()                       # values: a folder each
    (row,) = leads.read_rows()
    assert row.input.past == [ref_beta, ref_acme] and row.input.notes[0].text == "met at a meetup"


async def test_a_reference_to_a_missing_row_or_the_wrong_kind_is_refused(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, companies, leads = crm
    ghost = ref_of(companies.row_kind, "0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")
    assert leads.check({"input": {"name": "X", "company": ghost, "past": [], "notes": []}}) == [
        f"input.company: no {companies.row_kind} row 0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c"]
    with pytest.raises(LinkError):
        await leads.put("x", {"input": {"name": "X", "company": ghost, "past": [], "notes": []}})
    assert not (leads.asset_ref and (companies._owner() / "agentic-assets/dataset/leads/examples/x").exists())
    note_ref = ref_of(companies.row_kind.replace("crm.company", "crm.note"), "0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")
    assert "refers to a" in leads.check({"input": {"name": "X", "company": note_ref, "past": [], "notes": []}})[0]


async def test_a_row_still_referenced_cannot_be_deleted(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, companies, leads = crm
    (acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    await leads.append([{"key": "dana", "input": {"name": "Dana", "company": companies.ref_of(acme), "past": [], "notes": []}}])
    with pytest.raises(LinkError, match=f"used by {leads.row_kind} dana"):
        companies.delete_row("acme")
    leads.delete_row("dana")
    assert companies.delete_row("acme") == "acme"


async def test_put_with_a_stale_version_is_refused(crm):
    from flow_sdk.builtin.dataset import ConflictError

    _, companies, _ = crm
    await companies.put("acme", {"input": {"name": "Acme"}})
    seen = companies.example("acme")["version"]
    await companies.put("acme", {"input": {"name": "Acme Inc"}}, expected=seen)
    with pytest.raises(ConflictError):
        await companies.put("acme", {"input": {"name": "Acme Corp"}}, expected=seen)
    assert companies.example("acme")["input"]["name"] == "Acme Inc"


async def test_one_bad_row_never_hides_the_others(crm):
    root, _, leads = crm
    await leads.append([{"key": "dana", "input": {"name": "Dana", "past": [], "notes": []}}])
    bad = root / "agentic-assets/dataset/leads/examples/broken"
    (bad / "input").mkdir(parents=True)
    (bad / "input/lead.json").write_text('{"name": 7, "about": "not a reference"}')
    rows, problems = leads.rows_and_problems()
    assert [r.key for r in rows] == ["dana"]
    (problem,) = problems
    assert problem["key"] == "broken"
    assert [e.split(":")[0] for e in problem["errors"]] == ["input.name", "input.about"]   # every error, not the first


def test_the_row_kind_of_an_inline_and_a_named_spec(crm):
    from flow_sdk.datasets.links import datasets_for_kind

    root, companies, leads = crm
    assert companies.row_kind.endswith("--.crm.company") and leads.row_kind.endswith("--.crm.lead")
    assert [p.name for p in datasets_for_kind(leads.row_kind, root)] == ["leads"]


def test_a_date_is_a_checked_primitive():
    from pydantic import ValidationError

    from flow_sdk.schema.data_spec import DataSpec

    Day = DataSpec.parse({"day": "date", "seen": {"*": "date"}})
    assert Day(day="2026-10-08", seen={"mql": "2026-10-01"}).model_dump(mode="json") == {
        "day": "2026-10-08", "seen": {"mql": "2026-10-01"}}
    with pytest.raises(ValidationError):
        Day(day="yesterday", seen={})


def test_a_nested_schema_inherits_its_grouping_folders_namespace(tmp_path):
    from flow_sdk.schema.data_spec import DataSpec
    from flow_sdk.schema.data_spec.declared import load_root

    ns = "unittestgroup" + uuid.uuid4().hex[:8]
    group = tmp_path / "proj/agentic-assets/data_schema/crm"
    (group / "agentic-assets/data_schema/crm.thing").mkdir(parents=True)
    (group / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns}))
    (group / "agentic-assets/data_schema/crm.thing/data_schema.json").write_text(json.dumps(
        {"type": "data_schema", "fields": {"name": {"shape": "string"}}}))           # no ns of its own
    errors = {str(k): v for k, v in load_root(tmp_path / "proj").items() if v}
    assert not errors, errors
    assert DataSpec.parse(f"--{ns}--.crm.thing")(name="x").name == "x"


def test_apply_lists_the_keys_a_schema_carries_but_does_not_read(tmp_path):
    from flow_sdk.cli.commands.schema_cmd import apply_report

    folder = tmp_path / "crm.thing"
    folder.mkdir()
    (folder / "data_schema.json").write_text(json.dumps({"type": "data_schema", "name": "crm.thing", "fields": {}}))
    (entry,) = apply_report({folder: {"fields": {}, "subkind": "record"}})
    assert entry["ignored"] == ["name"]


async def test_the_datasets_of_a_kind_over_http(crm, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.server.routes.kinds import router

    _, companies, leads = crm

    async def indexed(*_args, **_kwargs):   # the rows an indexed project's DB answers
        return [companies, leads]

    monkeypatch.setattr(Dataset, "get_all", indexed)
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost") as client:
        resp = await client.get(f"/api/v1/kinds/{leads.row_kind}/datasets")
    assert [d["id"] for d in resp.json()["data"]["datasets"]] == [leads.id]


async def test_a_reference_to_a_kind_no_dataset_holds_must_be_a_stored_value(crm):
    """A link whose kind has no dataset beside it was accepted unchecked; it now has to name a value
    kept in a value store (``flow_sdk.values``), or it is refused like a dangling row link."""
    from flow_sdk.schema.data_spec import DataSpec
    from flow_sdk.values import save_value, store_of

    root, companies, leads = crm
    note_kind = leads.row_kind.replace("crm.lead", "crm.note")
    ghost = ref_of(note_kind, "0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c")
    errors = leads.check({"input": {"name": "Dana", "past": [], "notes": [ghost]}})
    assert errors == [f"input.notes.0: no {note_kind} row or stored value 0b7c8a2e-1f0d-4e5a-9c3b-2d4e6f8a1b3c"]
    kept = save_value(DataSpec.parse(note_kind)(text="kept once"), store_of(root))
    assert leads.check({"input": {"name": "Dana", "past": [], "notes": [kept]}}) == []


async def test_a_row_kind_written_inline_is_refused_link_it(crm):
    """A field typed by a row kind takes a value OR a reference; a value of a ROW kind (one a dataset
    beside holds) would escape the link checks and the delete protection, so it is refused."""
    _, companies, leads = crm
    (acme,) = await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    errors = leads.check({"input": {"name": "Dana", "company": {"name": "Acme copy"}, "past": [], "notes": []}})
    assert errors and errors[0].startswith("input.company: a ") and "written inline" in errors[0]
    assert leads.check({"input": {"name": "Dana", "company": companies.ref_of(acme), "past": [], "notes": [{"text": "a note, inline: fine"}]}}) == []


async def test_a_delete_with_a_stale_version_is_refused(crm):
    from flow_sdk.builtin.dataset import ConflictError

    _, companies, _ = crm
    await companies.put("acme", {"input": {"name": "Acme"}})
    seen = companies.example("acme")["version"]
    await companies.put("acme", {"input": {"name": "Acme Inc"}})
    with pytest.raises(ConflictError):
        companies.delete_row("acme", expected=seen)
    assert companies.delete_row("acme", expected=companies.example("acme")["version"]) == "acme"


async def test_a_broken_row_can_be_repaired_and_deleted_with_a_version_check(crm):
    """A row's version is a digest of its files, so a row that no longer fits has one too: it is
    reported with it, and a put or delete with that `expected` goes through (a stale one does not)."""
    from flow_sdk.builtin.dataset import ConflictError

    root, companies, _ = crm
    bad = root / "agentic-assets/dataset/companies/examples/broken"
    (bad / "input").mkdir(parents=True)
    (bad / "input/company.json").write_text('{"name": 7}')
    (problem,) = companies.rows_and_problems()[1]
    with pytest.raises(ConflictError):
        await companies.put("broken", {"input": {"name": "Fixed"}}, expected="0" * 16)
    await companies.put("broken", {"input": {"name": "Fixed"}}, expected=problem["version"])
    (row,) = companies.read_rows()
    assert row.input.name == "Fixed" and row.version and row.version != problem["version"]   # Python rows carry it
    assert companies.delete_row("broken", expected=row.version) == "broken"


async def test_store_ids_stamps_the_rows_that_still_have_a_derived_id(crm):
    from flow_sdk.schema.data_spec.layout import example_id

    root, companies, _ = crm
    old = root / "agentic-assets/dataset/companies/examples/old"
    (old / "input").mkdir(parents=True)
    (old / "input/company.json").write_text('{"name": "Old Co"}')
    (old / "example.json").write_text('{"metadata": {"kind": "train"}, "data": {}}')
    await companies.append([{"key": "new", "input": {"name": "New Co"}}])
    assert companies.store_ids() == 1                                   # only the legacy row
    assert json.loads((old / "example.json").read_text())["metadata"]["id"] == example_id(companies.id, "old")
    assert companies.store_ids() == 0


async def test_a_problem_carries_the_row_as_stored_so_it_can_be_found_by_a_natural_key(crm):
    root, companies, _ = crm
    bad = root / "agentic-assets/dataset/companies/examples/broken"
    (bad / "input").mkdir(parents=True)
    (bad / "input/company.json").write_text('{"name": 7}')
    (problem,) = companies.rows_and_problems()[1]
    assert problem["input"] == {"name": 7}
    assert problem["ref"] == companies.ref_of(problem["id"]) and problem["id"]   # a broken row is still a row


async def test_a_rename_with_a_stale_version_is_refused(crm):
    from flow_sdk.builtin.dataset import ConflictError

    _, companies, _ = crm
    await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    (row,) = companies.read_rows()
    with pytest.raises(ConflictError):
        companies.rename_row("acme", "acme-inc", expected="0" * 16)
    assert companies.rename_row("acme", "acme-inc", expected=row.version) == row.id


def test_the_datasets_of_a_kind_from_a_script(crm):
    from flow_sdk.builtin.dataset import Dataset

    root, companies, _ = crm
    (found,) = Dataset.for_kind(companies.row_kind, root)
    assert found.id == companies.id
    assert Dataset.for_kind(companies.row_kind + "_nobody", root) == []


async def test_a_row_that_no_longer_fits_still_protects_what_it_links_to(crm):
    from flow_sdk.builtin.dataset import LinkError

    root, companies, leads = crm
    await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    (co,) = companies.read_rows()
    await leads.append([{"key": "dana", "input": {"name": "Dana", "company": companies.ref_of(co.id), "past": [], "notes": []}}])
    doc = next((root / "agentic-assets/dataset/leads/examples/dana/input").glob("*.json"))
    doc.write_text(doc.read_text().replace('"Dana"', "7"))           # dana no longer reads
    assert leads.rows_and_problems()[1]
    with pytest.raises(LinkError, match="dana"):
        companies.delete_row("acme")


async def test_the_datasets_of_a_kind_over_http_skip_a_stale_index_entry(crm, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.server.routes import kinds

    root, companies, _ = crm
    stale = Dataset.at(root / "agentic-assets/dataset/companies")
    gone = stale.model_copy(update={"id": "x", "asset_ref": str(root / "agentic-assets/dataset/moved-away")})

    async def get_all(*_a, **_k):
        return [stale, gone, stale]                                   # a stale row and a doubled one
    monkeypatch.setattr(Dataset, "get_all", get_all)
    got = (await kinds.kind_datasets(companies.row_kind)).data["datasets"]
    assert [d["id"] for d in got] == [companies.id]


async def test_a_hidden_file_dropped_in_a_row_does_not_move_its_version(crm):
    root, companies, _ = crm
    await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    (before,) = companies.read_rows()
    (root / "agentic-assets/dataset/companies/examples/acme/.DS_Store").write_bytes(b"finder")
    (after,) = companies.read_rows()
    assert after.version == before.version
    await companies.put("acme", {"input": {"name": "Acme Inc"}}, expected=before.version)


# ── which datasets can link to a kind, and deleting many rows at once ─────────


def test_only_the_datasets_whose_schema_links_to_a_kind_are_its_linkers(crm):
    from flow_sdk.datasets.links import linkers_of

    root, companies, leads = crm
    ns = companies.row_kind.split("--")[1]
    notes = _dataset(root, "notes", f"--{ns}--.crm.note")
    names = lambda kind: [f.name for f in linkers_of(kind, root)]   # noqa: E731
    assert names(companies.row_kind) == ["leads"]              # a lead links to a company
    assert names(leads.row_kind) == ["leads"]                  # ... and to a lead (`about`)
    assert names(notes.row_kind) == ["leads"]                  # a lead HOLDS notes, so it can hold a ref to one
    assert names(f"--{ns}--.crm.nobody") == []


def test_a_dataset_whose_kind_is_not_registered_may_link_to_anything(crm):
    from flow_sdk.datasets.links import linkers_of

    root, companies, _ = crm
    _dataset(root, "mystery", "--nobody--.un.registered")
    assert [f.name for f in linkers_of(companies.row_kind, root)] == ["leads", "mystery"]


def test_a_dataset_reaching_a_kind_through_another_kind_is_its_linker_too(crm):
    from flow_sdk.datasets.links import linkers_of
    from flow_sdk.schema.data_spec.declared import load_root

    root, companies, leads = crm
    ns = companies.row_kind.split("--")[1]
    _schema(root, ns, "crm.deal", {"lead": {"shape": "crm.lead", "description": "Whose deal."}})
    assert not any(load_root(root).values())
    _dataset(root, "deals", f"--{ns}--.crm.deal")
    assert [f.name for f in linkers_of(companies.row_kind, root)] == ["deals", "leads"]   # a deal's lead names a company
    assert [f.name for f in linkers_of(f"--{ns}--.crm.deal", root)] == []


async def test_deleting_a_row_nothing_can_link_to_reads_no_other_row(crm, monkeypatch):
    from flow_sdk.builtin.dataset import Dataset

    root, companies, leads = crm
    await companies.append([{"key": "acme", "input": {"name": "Acme"}}])
    ns = companies.row_kind.split("--")[1]
    notes = _dataset(root, "notes", f"--{ns}--.crm.note")
    _schema(root, ns, "crm.tag", {"name": {"shape": "string", "description": "A tag."}})
    from flow_sdk.schema.data_spec.declared import load_root
    assert not any(load_root(root).values())
    tags = _dataset(root, "tags", f"--{ns}--.crm.tag")
    await tags.append([{"key": f"t{n}", "input": {"name": f"T{n}"}} for n in range(5)])
    read = []
    monkeypatch.setattr(Dataset, "read_lenient", lambda self: read.append(self._folder().name) or ([], []))
    assert tags.delete_rows(["t0", "t1", "t2"]) == ["t0", "t1", "t2"]
    assert read == []                                           # no schema links to a tag: nothing is scanned
    companies.delete_rows(["acme"])
    assert read == ["leads"]                                    # one read of the one dataset that can, per CALL
    assert notes.rows_and_problems() == ([], [])


async def test_delete_rows_is_all_or_nothing(crm):
    from flow_sdk.builtin.dataset import ConflictError, LinkError

    _, companies, leads = crm
    ids = await companies.append([{"key": k, "input": {"name": k}} for k in ("acme", "bolt", "core")])
    await leads.append([{"key": "dana", "input": {"name": "Dana", "company": companies.ref_of(ids[1]), "past": [], "notes": []}}])
    keys = lambda: sorted(r.key for r in companies.read_rows())   # noqa: E731
    with pytest.raises(LinkError, match=f"bolt: used by {leads.row_kind} dana"):
        companies.delete_rows(["acme", "bolt", "core"])
    with pytest.raises(LookupError, match="ghost"):
        companies.delete_rows(["acme", "ghost"])
    with pytest.raises(ConflictError, match="core"):
        companies.delete_rows(["acme", "core"], expected={"core": "0" * 16})
    assert keys() == ["acme", "bolt", "core"]                    # every refusal removed nothing
    seen = companies.example("core")["version"]
    assert companies.delete_rows(["acme", "core", "acme"], expected={"core": seen}) == ["acme", "core"]
    assert keys() == ["bolt"]


async def test_rows_deleted_together_do_not_hold_each_other_back(crm):
    from flow_sdk.builtin.dataset import LinkError

    _, _, leads = crm
    (dana,) = await leads.append([{"key": "dana", "input": {"name": "Dana", "past": [], "notes": []}}])
    await leads.append([{"key": "eli", "input": {"name": "Eli", "about": leads.ref_of(dana), "past": [], "notes": []}}])
    with pytest.raises(LinkError, match="eli"):
        leads.delete_rows(["dana"])
    assert leads.delete_rows(["dana", "eli"]) == ["dana", "eli"]
    assert leads.read_rows() == []


async def test_a_kind_links_to_itself_in_a_namespaced_project(crm):
    _, _, leads = crm
    (dana,) = await leads.append([{"key": "dana", "input": {"name": "Dana", "past": [], "notes": []}}])
    assert leads.check({"input": {"name": "Eli", "about": leads.ref_of(dana), "past": [], "notes": []}}) == []
