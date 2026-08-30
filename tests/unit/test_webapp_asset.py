"""A webapp is an asset like any other — including nested inside another asset.

The mechanism under test is deliberately NOT new: ``repo_assets_fn`` already
recurses through ``agentic-assets/`` and the enclosure rule already makes the
containing asset the parent. What these tests pin is that ``micro_app`` is
enrolled correctly enough to ride that machinery, and that an asset-backed app
serves out of ``<app folder>/<build>``.

Fast, real filesystem, no mocks.
"""

import json

import pytest

from flow_sdk.builtin.faas.micro_app import AppLocationType, MicroApp
from flow_sdk.builtin.faas.serve_static import AppNotBuilt
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR, AssetClass
from flow_sdk.fs_store.schema_registry import SchemaRegistry

AA = AGENTIC_ASSETS_DIR


def _webapp(folder, **manifest):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "webapp.json").write_text(json.dumps({"name": folder.name, **manifest}))
    (folder / "index.html").write_text("<h1>hi</h1>")
    return folder


# ── enrollment ──────────────────────────────────────────────────────────────
def test_micro_app_is_a_repo_type():
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    info = SchemaRegistry.get("micro_app")
    assert info.asset_class == AssetClass.REPO
    # The folder a human reads is named for the thing, not for the delivery row.
    assert info.family == "webapp"
    assert SchemaRegistry.repo_family_to_info()["webapp"].type_name == "micro_app"
    # asset_ref must stay the FOLDER: serving joins <folder>/<build> onto it.
    assert info.main_layout == "folder" and not info.main_file_is_asset_ref


# ── discovery: an editor nested inside the asset it edits ───────────────────
def test_editor_is_discovered_as_a_child_of_the_asset_it_edits(tmp_path):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    spec = tmp_path / AA / "data_source" / "rss"
    spec.mkdir(parents=True)
    (spec / "data_source.json").write_text(json.dumps({"schema": 1, "name": "rss"}))
    editor = _webapp(spec / AA / "webapp" / "editor", kind="application.web.editor")

    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions())
    found = {r._path: r for r in refs}

    assert found[editor].record_type == EntityType.MICRO_APP
    # The physical nesting IS the parent chain the enclosure rule reads.
    assert found[editor]._parent._path == spec


def test_a_folder_without_the_manifest_is_not_a_webapp(tmp_path):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions

    stray = tmp_path / AA / "webapp" / "not-an-app"
    stray.mkdir(parents=True)
    (stray / "index.html").write_text("<h1>hi</h1>")

    assert repo_assets_fn([FSRef(tmp_path)], IndexerOptions()) == []


# ── loading: the disk supplies what the manifest cannot say ────────────────
def test_loading_derives_the_location_from_where_it_was_found(tmp_path):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    folder = _webapp(tmp_path / AA / "webapp" / "editor", kind="application.web.editor", title="Spec editor")
    info = SchemaRegistry.get("micro_app")
    records = info.from_disk_fn(_ref(folder), "0f0f0f0f-0000-4000-8000-00000000abcd")

    (rec,) = records
    assert rec.location_type == AppLocationType.Asset
    assert rec.asset_ref._path == folder
    assert rec.kind == "application.web.editor"
    # A machine path never appears in webapp.json — it is derived, every time.
    assert "location_root" not in json.loads((folder / "webapp.json").read_text())


def test_identity_is_derived_from_the_path_so_it_is_the_same_everywhere(tmp_path):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    folder = _webapp(tmp_path / AA / "webapp" / "editor")
    info = SchemaRegistry.get("micro_app")

    first = info.mint_entity_id(_ref(folder))
    second = info.mint_entity_id(_ref(folder))
    assert first == second
    # Derived means nothing is written into the asset — a shipped editor cannot
    # arrive carrying the sender's id, and git stays clean.
    assert set(p.name for p in folder.iterdir()) == {"webapp.json", "index.html"}


def _ref(path):
    from flow_sdk.fs_store.fs_ref import FSRef

    return FSRef(path)


# ── serving: we start the app folder, we serve the build ───────────────────
def test_serving_root_is_the_build_inside_the_app_folder(tmp_path):
    app = tmp_path / "app"
    (app / "dist").mkdir(parents=True)

    row = MicroApp(name="a", location_type=AppLocationType.Asset, asset_ref=str(app), build="dist")
    assert row.serving_root() == (app / "dist").resolve()


def test_a_static_app_serves_out_of_its_own_folder(tmp_path):
    app = _webapp(tmp_path / "editor")
    row = MicroApp(name="editor", location_type=AppLocationType.Asset, asset_ref=str(app), build=".")
    assert row.serving_root() == app.resolve()


def test_an_unbuilt_app_is_not_built_rather_than_misconfigured(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    row = MicroApp(name="a", location_type=AppLocationType.Asset, asset_ref=str(app), build="dist")

    # AppNotBuilt is what the display turns into a build CTA; a ValueError would
    # read as "this row is broken" and offer nothing to do about it.
    with pytest.raises(AppNotBuilt):
        row.serving_root()


def test_kind_goes_through_the_shared_ontology(tmp_path):
    row = MicroApp(name="a", location_type=AppLocationType.Asset, asset_ref=str(tmp_path), kind="Application.Web.Editor")
    assert row.kind == "application.web.editor"
    with pytest.raises(ValueError):
        MicroApp(name="a", location_type=AppLocationType.Asset, asset_ref=str(tmp_path), kind="not a kind!")
