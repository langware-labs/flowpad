"""The schemas a project defines, as one tree: each kind with the kinds its fields name -- LINKED when
a dataset keeps rows of the kind, held INSIDE the row when nobody does -- and the dataset that keeps
its own rows.

Built on a real project tree: data_schema folders on disk, datasets beside them.
"""

from __future__ import annotations

import json
import uuid

import pytest

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
        {"metadata": {"data_layout": "io_folder", "spec": {"rows": [{"input": kind}]}}, "data": {}}))
    return Dataset.at(folder)


@pytest.fixture
def crm(tmp_path):
    root = tmp_path / "proj"
    ns = "unittesttree" + uuid.uuid4().hex[:8]   # kinds are process-wide: one namespace per test
    _schema(root, ns, "crm.company", {"name": {"shape": "string", "description": "The company."}})
    _schema(root, ns, "crm.note", {"text": {"shape": "string", "description": "One line."}})
    _schema(root, ns, "crm.lead", {
        "name": {"shape": "string", "description": "The person."},
        "company": {"shape": "?crm.company", "description": "Where they work."},
        "past": {"shape": ["crm.company"], "description": "Where they worked."},
        "notes": {"shape": ["crm.note"], "description": "Notes, as values."},
    })
    return root, ns, [_dataset(root, "companies", f"--{ns}--.crm.company"), _dataset(root, "leads", f"--{ns}--.crm.lead")]


def _tree(root, datasets, projects=None):
    from flow_sdk.datasets.schema_tree import schema_tree
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    mounts = tuple((canonical_posix_path(str(folder)), pid) for folder, pid in (projects or {root: "p1"}).items())
    return {node.name: node for node in schema_tree(root, datasets, mounts).schemas}


def test_every_kind_the_project_defines_is_listed_with_where_it_is_defined(crm):
    root, ns, datasets = crm
    nodes = _tree(root, datasets)
    assert sorted(nodes) == ["crm.company", "crm.lead", "crm.note"]
    lead = nodes["crm.lead"]
    assert lead.kind == f"--{ns}--.crm.lead"
    assert lead.folder == "agentic-assets/data_schema/crm.lead"
    assert [(f.name, f.required, f.description) for f in lead.fields][:2] == [
        ("name", True, "The person."), ("company", False, "Where they work.")]


def test_a_kind_a_dataset_keeps_is_linked_and_any_other_is_held_inside(crm):
    root, ns, datasets = crm
    lead = _tree(root, datasets)["crm.lead"]
    # ``company`` is named by two fields and listed once.
    assert [(u.kind, u.held, u.project_id) for u in lead.uses] == [
        (f"--{ns}--.crm.company", "link", "p1"), (f"--{ns}--.crm.note", "inside", "p1")]


def test_a_kind_names_the_dataset_that_keeps_its_rows(crm):
    root, _ns, datasets = crm
    datasets[0].source_id = "src-1"
    datasets[0].num_rows = 4
    nodes = _tree(root, datasets)
    assert nodes["crm.company"].dataset.model_dump() == {
        "id": datasets[0].id, "title": "companies", "rows": 4, "source_id": "src-1"}
    assert nodes["crm.note"].dataset is None


def test_a_kind_another_project_defines_names_that_project(crm, tmp_path):
    from flow_sdk.schema.data_spec.declared import load_root

    root, ns, datasets = crm
    other = tmp_path / "other"
    _schema(other, ns, "crm.region", {"name": {"shape": "string", "description": "The region."}})
    assert not any(load_root(other).values())
    _schema(root, ns, "crm.office", {"region": {"shape": "crm.region", "description": "Where it is."}})
    office = _tree(root, datasets, {root: "p1", other: "p2"})["crm.office"]
    assert [(u.kind, u.held, u.project_id) for u in office.uses] == [(f"--{ns}--.crm.region", "inside", "p2")]
