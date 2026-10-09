"""Kinds DEFINED BY A FOLDER (``agentic-assets/data_schema/<full.kind>/data_schema.json``).

Built into a named DataSpec and registered through the ordinary class hook, under the namespace
of the project the folder lives in. These pin the mechanics, each driven through the real loader
(``declared.load_root``) or the real asset reader (``read_asset_data``) over folders on disk.
"""

from __future__ import annotations

import itertools
import json
import os
from pathlib import Path

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec import declared

pytestmark = pytest.mark.timeout(5)

_seq = itertools.count()


def _ns() -> str:
    """A fresh namespace per test: a registered kind is process-wide."""
    return f"unitdecl{next(_seq)}p{os.getpid()}"


def _spec(parent: Path, kind: str, body: dict, *, ns: str | None = None) -> Path:
    folder = parent / "agentic-assets" / "data_schema" / kind
    folder.mkdir(parents=True)
    (folder / "data_schema.json").write_text(json.dumps({"type": "data_schema", **body, **({"ns": ns} if ns else {})}))
    return folder


def _nav_tree(root: Path, ns: str) -> None:
    """Parent names children; a child names its own child; nothing is in dependency order on disk."""
    top = _spec(
        root,
        "nav.dataset",
        {"examples": {"input": "nav.request", "context": "nav.context", "output": "nav.decision"}},
        ns=ns,
    )
    _spec(
        top,
        "nav.request",
        {"fields": {"utterance": {"shape": "string", "description": "what was typed"}, "page": {"shape": "?string"}}},
        ns=ns,
    )
    ctx = _spec(top, "nav.context", {"fields": {"candidates": {"shape": ["nav.candidate"]}}}, ns=ns)
    _spec(ctx, "nav.candidate", {"fields": {"typeid": {"shape": "string"}}}, ns=ns)
    _spec(
        top,
        "nav.decision",
        {"fields": {"route": {"shape": "enum:quick|agentic"}, "target": {"shape": "?string"}}},
        ns=ns,
    )


def _kind(ns: str, kind: str):
    return SchemaRegistry.kind_type(f"--{ns}--.{kind}")


def test_a_nested_tree_registers_every_kind_in_dependency_order(tmp_path):
    ns = _ns()
    _nav_tree(tmp_path, ns)
    assert set(declared.load_root(tmp_path).values()) == {""}
    ctx = _kind(ns, "nav.context")(candidates=[{"typeid": "task-1"}])
    assert ctx.candidates[0].typeid == "task-1", "a grandchild kind resolved -- not Any"
    req = _kind(ns, "nav.request")
    assert req(utterance="hi").page is None and req.model_fields["utterance"].description == "what was typed"
    with pytest.raises(ValueError):
        _kind(ns, "nav.decision")(route="maybe")


def test_an_authored_kind_lands_in_its_namespace_never_in_ours(tmp_path):
    ns = _ns()
    _spec(tmp_path, "solo.kind", {"fields": {"a": {"shape": "string"}}}, ns=ns)
    declared.load_root(tmp_path)
    assert _kind(ns, "solo.kind") is not None
    assert SchemaRegistry.kind_type("solo.kind") is None


def test_a_folder_under_the_retired_data_spec_name_registers_nothing_and_says_so(tmp_path):
    """The family was renamed ``data_spec`` -> ``data_schema`` with no migration: an old folder is
    not read, and the indexer's scan names it with the rename -- never a silent loss of its kinds."""
    from flow_sdk.assets.scanning import scan_repo_tree

    ns = _ns()
    old = tmp_path / "agentic-assets" / "data_spec" / "legacy.kind"
    old.mkdir(parents=True)
    (old / "data_spec.json").write_text(
        json.dumps({"type": "data_spec", "ns": ns, "fields": {"a": {"shape": "string"}}})
    )

    assert declared.load_root(tmp_path) == {}
    assert _kind(ns, "legacy.kind") is None
    result = scan_repo_tree(tmp_path, SchemaRegistry.repo_family_to_info())
    assert result.candidates == []
    [issue] = result.issues
    assert (issue.path, issue.type_name) == (old.parent, "data_schema")
    assert "rename it to data_schema/" in issue.message and "data_schema.json" in issue.message


def test_a_documentation_node_registers_nothing(tmp_path):
    ns = _ns()
    folder = _spec(tmp_path, "branch", {}, ns=ns)
    assert declared.load_root(tmp_path) == {folder: ""}
    assert _kind(ns, "branch") is None


def test_a_dataset_definition_types_the_dataset_that_names_it(tmp_path):
    from flow_sdk.builtin.dataset import Dataset

    ns = _ns()
    _nav_tree(tmp_path, ns)
    declared.load_root(tmp_path)
    d = Dataset(name="n", data_layout="io_folder", spec=f"--{ns}--.nav.dataset")
    assert (d.input_shape, d.output_shape) == (_kind(ns, "nav.request"), _kind(ns, "nav.decision"))


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"subkind": "dataset", "fields": {"a": {"shape": "string"}}}, "subkind 'dataset' declared"),
        ({"fields": {"a": {"shape": "string"}}, "examples": {"input": "string"}}, "one shape"),
        ({"fields": {"a": {"shape": "nobody.defines.this"}}}, "nobody defines"),
        ({"examples": {"output": "string"}}, '"input"'),
        ({"fields": {"a": {"shape": "enum:x||y"}}}, "enum"),
    ],
    ids=["subkind-mismatch", "two-bodies", "unknown-kind", "dataset-without-input", "bad-enum"],
)
def test_a_bad_definition_is_recorded_on_the_folder_not_raised(tmp_path, body, fragment):
    folder = _spec(tmp_path, "bad.kind", body, ns=_ns())
    assert fragment in declared.load_root(tmp_path)[folder]


def test_the_same_kind_in_two_folders_is_an_error(tmp_path):
    ns = _ns()
    first = _spec(tmp_path / "one", "dup.kind", {"fields": {"a": {"shape": "string"}}}, ns=ns)
    second = _spec(tmp_path / "two", "dup.kind", {"fields": {"b": {"shape": "int"}}}, ns=ns)
    assert declared.load_root(tmp_path / "one")[first] == ""
    assert "already defined" in declared.load_root(tmp_path / "two")[second]


def test_a_moved_definition_takes_its_kind_with_it_without_a_restart(tmp_path):
    """The marketing case: specs moved out of their datasets into one tree, then re-indexed."""
    import shutil

    ns = _ns()
    old = _spec(tmp_path / "dataset", "gtm.icp", {"fields": {"a": {"shape": "string"}}}, ns=ns)
    assert declared.load_root(tmp_path / "dataset")[old] == ""
    new = tmp_path / "tree" / "agentic-assets" / "data_schema" / "gtm.icp"
    new.parent.mkdir(parents=True)
    shutil.move(str(old), str(new))
    (new / "data_schema.json").write_text(
        json.dumps({"type": "data_schema", "ns": ns, "fields": {"b": {"shape": "int"}}})
    )
    assert declared.load_root(tmp_path / "tree")[new] == ""
    assert set(_kind(ns, "gtm.icp").model_fields) == {"b"}


def test_a_kind_its_folder_no_longer_names_is_free_for_another(tmp_path):
    ns = _ns()
    first = _spec(tmp_path / "one", "free.kind", {"fields": {"a": {"shape": "string"}}}, ns=ns)
    assert declared.load_root(tmp_path / "one")[first] == ""
    (first / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns + "x", "fields": {}}))
    second = _spec(tmp_path / "two", "free.kind", {"fields": {"b": {"shape": "int"}}}, ns=ns)
    assert declared.load_root(tmp_path / "two")[second] == ""


def test_a_namespace_the_marker_cannot_hold_is_recorded_not_raised(tmp_path):
    """``ns-v`` is not a namespace (``--ns-v--`` breaks the marker grammar): a bad document, recorded
    on the folder -- it used to raise out of indexing (found by the every-asset round trip)."""
    folder = _spec(tmp_path, "badns.kind", {"fields": {"a": {"shape": "string"}}}, ns="ns-v")
    assert "namespace" in declared.load_root(tmp_path)[folder]


def test_an_external_that_names_no_namespace_is_refused(tmp_path):
    folder = _spec(tmp_path, "nons.kind", {"fields": {"a": {"shape": "string"}}})
    assert "declares no `ns`" in declared.load_root(tmp_path)[folder]


def test_a_dataset_keeps_the_spec_its_own_nested_definitions_define(tmp_path):
    """The walk reads a parent BEFORE its children, so the header read used to meet a kind nobody had
    registered yet and drop the spec (``_lenient_spec``). An asset's own data schemas are now in scope
    for its own document -- proven by an on/off lever before the fix."""
    from flow_sdk.assets.serialization import read_asset_data

    ns = _ns()
    ds = tmp_path / "agentic-assets" / "dataset" / "nav"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(
        json.dumps({"metadata": {"data_layout": "io_folder", "spec": f"--{ns}--.nav.dataset"}, "data": {}})
    )
    _nav_tree(ds, ns)
    record = read_asset_data(ds, SchemaRegistry.get("dataset"), identity="9a7b2a8e-6f1d-4c3b-8a2e-0f1e2d3c4b5a")
    assert record.meta_dict().get("spec") == f"--{ns}--.nav.dataset"


def test_indexing_a_definition_again_keeps_the_classes_rows_were_written_with(tmp_path):
    """Indexing reaches one definition several ways (the dataset's own read, each data schema folder,
    the miss loader). A rebuild REPLACED the registered class while the dataset kind kept the old
    one, which then had no kind -- so typed reads looked for ``declared_nav_request.json`` and every
    row failed. Found in the browser on a live instance; proven by an on/off lever."""
    from flow_sdk.assets.serialization import read_asset_data
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.schema.data_spec.dataset_spec import ExampleKind
    from flow_sdk.schema.data_spec.layout import FolderLayout

    ns = _ns()
    ds = tmp_path / "agentic-assets" / "dataset" / "nav"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(
        json.dumps({"metadata": {"data_layout": "io_folder", "spec": f"--{ns}--.nav.dataset"}, "data": {}})
    )
    _nav_tree(ds, ns)
    read_asset_data(ds, SchemaRegistry.get("dataset"), identity="0b7c3a2e-6f1d-4c3b-8a2e-0f1e2d3c4b5a")
    declared.load_root(ds)  # what indexing the nested data schema folders does
    d = Dataset(
        id="0b7c3a2e-6f1d-4c3b-8a2e-0f1e2d3c4b5a",
        name="nav",
        asset_ref=str(ds),
        data_layout="io_folder",
        spec=f"--{ns}--.nav.dataset",
    )
    row = d.row_type
    FolderLayout().append_many(
        ds,
        [
            (
                row(
                    kind=ExampleKind.EVAL,
                    input={"utterance": "hi"},
                    context={"candidates": []},
                    ground_truth={"route": "agentic"},
                ),
                None,
            )
        ],
        dataset_id=d.id,
    )
    for folder in declared.data_schema_folders(ds):  # the indexer reaching every definition again
        declared.register_folder(folder)
    assert d.validate_rows() == []
    assert (ds / "examples/0001/input/request.json").is_file()


def test_a_changed_definition_rebuilds_and_rows_written_before_still_read(tmp_path):
    """A REAL rebuild (the document changed) replaces the registered class; a class built earlier
    still holds the old one. A file is named by the class's own registered tag, so the old class
    keeps its name -- ``request.json``, never ``declared_..._request.json``."""
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.schema.data_spec.dataset_spec import ExampleKind
    from flow_sdk.schema.data_spec.layout import FolderLayout

    ns = _ns()
    ds = tmp_path / "agentic-assets" / "dataset" / "nav"
    ds.mkdir(parents=True)
    _nav_tree(ds, ns)
    declared.load_root(ds)
    d = Dataset(
        id="1c8d3a2e-6f1d-4c3b-8a2e-0f1e2d3c4b5a",
        name="nav",
        asset_ref=str(ds),
        data_layout="io_folder",
        spec=f"--{ns}--.nav.dataset",
    )
    FolderLayout().append_many(
        ds,
        [(d.row_type(kind=ExampleKind.EVAL, input={"utterance": "hi"}, context={"candidates": []}), None)],
        dataset_id=d.id,
    )
    request = next(f for f in declared.data_schema_folders(ds) if f.name == "nav.request")
    doc = json.loads((request / "data_schema.json").read_text())
    doc["fields"]["utterance"]["description"] = "exactly what was typed"
    (request / "data_schema.json").write_text(json.dumps(doc))
    assert declared.register_folder(request) == ""
    assert d.validate_rows() == []
