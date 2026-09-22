"""A webapp is an asset like any other — including nested inside another asset.

The mechanism under test is deliberately NOT new: ``repo_assets_fn`` already
recurses through ``agentic-assets/`` and the enclosure rule already makes the
containing asset the parent. What these tests pin is that ``micro_app`` is
enrolled correctly enough to ride that machinery, and that a folder with no
build yet is "not built" rather than broken. (Serving ``<app folder>/<build>``
is the ``static`` endpoint indexing gives it: ``tests/api/test_webapp_endpoints.py``.)

Fast, real filesystem, no mocks.
"""

import json

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — enrolls MICRO_APP
from flow_sdk.assets.layout import Folder
from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR, AssetClass
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.faas.serve_static import AppNotBuilt, serve_app_bytes
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.fixtures.identity import resolve_id

AA = AGENTIC_ASSETS_DIR


def _ref(path):
    return FSRef(path)


def _request():
    """A minimal ASGI request on an endpoint's service path."""
    from starlette.requests import Request

    return Request({
        "type": "http",
        "method": "GET",
        "headers": [(b"host", b"localhost")],
        "path": "/api/v1/graph/service_endpoint/0f0f0f0f-0000-4000-8000-00000000abcd/service/",
        "query_string": b"",
    })


def _webapp(folder, **manifest):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "webapp.json").write_text(json.dumps({"name": folder.name, **manifest}))
    (folder / "index.html").write_text("<h1>hi</h1>")
    return folder


# ── enrollment ──────────────────────────────────────────────────────────────
def test_micro_app_is_a_repo_type():
    info = SchemaRegistry.get("micro_app")
    assert info.asset_class == AssetClass.REPO
    # The folder a human reads is named for the thing, not for the delivery row.
    assert info.family == "webapp"
    assert SchemaRegistry.repo_family_to_info()["webapp"].type_name == "micro_app"
    # asset_ref must stay the FOLDER: serving joins <folder>/<build> onto it.
    assert isinstance(info.shape, Folder)


# ── discovery: an editor nested inside the asset it edits ───────────────────
def test_editor_is_discovered_as_a_child_of_the_asset_it_edits(tmp_path):
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    spec = tmp_path / AA / "data_driver" / "rss"
    spec.mkdir(parents=True)
    (spec / "data_driver.json").write_text(json.dumps({"schema": 1, "name": "rss"}))
    editor = _webapp(spec / AA / "webapp" / "editor", kind="application.web.editor")

    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions())
    found = {r._path: r for r in refs}

    assert found[editor].record_type == EntityType.MICRO_APP
    # The physical nesting IS the parent chain the enclosure rule reads.
    assert found[editor]._parent._path == spec


def test_a_folder_without_the_manifest_is_not_a_webapp(tmp_path):
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions

    stray = tmp_path / AA / "webapp" / "not-an-app"
    stray.mkdir(parents=True)
    (stray / "index.html").write_text("<h1>hi</h1>")

    assert repo_assets_fn([FSRef(tmp_path)], IndexerOptions()) == []


# ── loading: the disk supplies what the manifest cannot say ────────────────
def test_loading_derives_the_location_from_where_it_was_found(tmp_path):
    folder = _webapp(tmp_path / AA / "webapp" / "editor", kind="application.web.editor", title="Spec editor")
    info = SchemaRegistry.get("micro_app")
    records = info.from_disk_fn(_ref(folder), "0f0f0f0f-0000-4000-8000-00000000abcd")

    (rec,) = records
    assert rec.asset_ref._path == folder
    assert rec.kind == "application.web.editor"
    # A machine path never appears in webapp.json — it is derived, every time.
    assert "location_root" not in json.loads((folder / "webapp.json").read_text())


def test_identity_is_derived_from_the_path_so_it_is_the_same_everywhere(tmp_path):
    folder = _webapp(tmp_path / AA / "webapp" / "editor")
    info = SchemaRegistry.get("micro_app")

    first = resolve_id(info, _ref(folder))
    second = resolve_id(info, _ref(folder))
    assert first == second
    # Derived means nothing is written into the asset — a shipped editor cannot
    # arrive carrying the sender's id, and git stays clean.
    assert set(p.name for p in folder.iterdir()) == {"webapp.json", "index.html"}



# ── serving: the build folder, once there is one ────────────────────────────
@pytest.mark.asyncio
async def test_an_unbuilt_app_is_not_built_rather_than_misconfigured(tmp_path):
    app = tmp_path / "app"
    app.mkdir()

    # AppNotBuilt is what the display turns into a build CTA; a ValueError would
    # read as "this row is broken" and offer nothing to do about it.
    with pytest.raises(AppNotBuilt):
        await serve_app_bytes(app / "dist", None, _request())


def test_a_row_with_no_folder_is_not_a_folder_asset(tmp_path):
    """A ``micro_app`` row with no folder is a delivery row from before endpoints.

    It must answer DB-only, so dropping it (``prune_delivery_rows``) never computes
    an ``asset_ref`` under ``agentic-assets/webapp/`` and touches a folder there.
    """
    row = WebApp(name="Legacy Static", parent_type_id="dataset-11111111-2222-4333-8444-555555555555")
    assert not row.is_file_backed()
    assert WebApp(name="editor", asset_ref=str(tmp_path)).is_file_backed()


def test_kind_goes_through_the_shared_ontology(tmp_path):
    row = WebApp(name="a", asset_ref=str(tmp_path), kind="Application.Web.Editor")
    assert row.kind == "application.web.editor"
    with pytest.raises(ValueError):
        WebApp(name="a", asset_ref=str(tmp_path), kind="not a kind!")
