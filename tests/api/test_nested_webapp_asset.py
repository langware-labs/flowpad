"""A webapp asset nested inside another asset, end to end through the real routes.

This is the replacement for the editor action that used to live beside it. The
point of the change is that there is no longer a second implementation to test:
an editor is a `micro_app` like any other, so it is discovered by the ordinary
repo walker, served by ``MicroApp.view``, and addressed by its own row. What is
worth pinning is that the whole chain actually holds together — discovery gives
the app a PARENT, and serving reaches the app's own folder and nothing above it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.serve_static import API_ORIGIN_SNIPPET
from flow_sdk.core.display_target import resolve_display_target
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR as AA

pytestmark = pytest.mark.asyncio


def _definition_with_editor(root: Path) -> tuple[Path, Path]:
    """A source definition that ships an editor, laid out exactly as the shipped ones."""
    spec = root / AA / "data_source" / "demo"
    spec.mkdir(parents=True)
    (spec / "data_source.json").write_text(json.dumps({"schema": 1, "name": "demo", "title": "Demo"}))

    app = spec / AA / "webapp" / "editor"
    app.mkdir(parents=True)
    (app / "webapp.json").write_text(
        json.dumps({"name": "editor", "title": "Demo editor", "kind": "application.web.editor", "build": "."})
    )
    (app / "index.html").write_text("<html><head><title>Editor</title></head><body>editor</body></html>")
    (app / "app.js").write_text("console.log('editor')")
    (spec / "outside.txt").write_text("OUTSIDE THE APP")
    return spec, app


async def _index(root: Path) -> dict:
    """Index the tree and return `{type: {name: row}}` for what the walker found."""
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.record_types import RecordType

    # The REAL walker, not a bespoke one: discovery of a nested app is exactly
    # the recursion `repo_assets_fn` already does for every repo asset.
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(
        RecordType.USER_HOME_FOLDER,
        repo_assets_fn,
        frozenset({RecordType.DATA_SOURCE_SPEC, RecordType.MICRO_APP}),
    )
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.DATA_SOURCE_SPEC, RecordType.MICRO_APP]))
    from flow_sdk.builtin.data_source_spec import DataSourceSpec  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415

    # Scoped to THIS tree, not to the name: "demo"/"editor" are ordinary words and
    # the DB is shared across the suite, so a name lookup can answer with another
    # test's row and pass or fail for the wrong reason.
    under = str(root.resolve())
    specs = [s for s in await DataSourceSpec.get_all({"name": "demo"}) if str(s.asset_ref).startswith(under)]
    apps = [a for a in await MicroApp.get_all({"name": "editor"}) if str(a.asset_ref).startswith(under)]
    return {"spec": specs[0] if specs else None, "app": apps[0] if apps else None}


async def test_a_nested_editor_is_indexed_as_a_child_of_its_definition(bootstrapped_client, user, tmp_path):
    _definition_with_editor(tmp_path)
    rows = await _index(tmp_path)

    spec, app = rows["spec"], rows["app"]
    assert spec is not None and app is not None, "the walker found both levels"
    # THE point of nesting: containment is the parent edge, so the app inherits a
    # breadcrumb without anything declaring the relationship.
    assert app.parent_type_id == str(spec.typeid)
    assert app.kind == "application.web.editor"
    assert app.location_type == "Asset"


async def test_the_editor_is_served_like_any_other_webapp(bootstrapped_client, user, tmp_path):
    _definition_with_editor(tmp_path)
    app = (await _index(tmp_path))["app"]

    # The SAME route a built-from-source app is served on. There is no second
    # implementation to reach an editor through any more.
    resp = await bootstrapped_client.get(f"/api/v1/graph/micro_app/{app.id}/view/")
    assert resp.status_code == 200
    body = resp.text
    assert API_ORIGIN_SNIPPET in body, "the page must learn its backend origin"
    assert "<base" in body
    # An asset under edit, not a released bundle: its app.js keeps one name across
    # every save, so a heuristically cached copy would be the previous version.
    assert resp.headers.get("cache-control") == "no-cache"


async def test_nothing_above_the_app_folder_is_reachable(bootstrapped_client, user, tmp_path):
    _definition_with_editor(tmp_path)
    app = (await _index(tmp_path))["app"]

    resp = await bootstrapped_client.get(f"/api/v1/graph/micro_app/{app.id}/view/%2E%2E%2Foutside.txt")
    assert resp.status_code == 403
    assert "OUTSIDE THE APP" not in resp.text


async def test_showing_the_editor_resolves_to_the_app_dock(bootstrapped_client, user, tmp_path):
    _definition_with_editor(tmp_path)
    app = (await _index(tmp_path))["app"]

    # An app is RUN, not edited as a document — so a typeid target routes to the
    # app dock rather than to a manifest view.
    target = await resolve_display_target(typeid=str(app.typeid))
    assert target["kind"] == "app"
    assert target["typeid"] == str(app.typeid)
    assert target["runtime"] == "served"
    assert "artifact_id" not in target, "a webapp asset has no source plane"
