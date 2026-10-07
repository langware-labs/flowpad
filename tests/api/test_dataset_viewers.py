"""Which viewer shows a value of a kind: nested in the asset being shown, then the most specific kind
(by the ontology), then ``*`` -- and only viewers that show the asked shape (single / collection).

The real indexer over a tree on disk, then ``GET /api/v1/viewers`` and the module it names, served
as JavaScript. Nothing is doubled.
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

import pytest

from tests.api.test_dataset_editors import _app, _dataset, _datasets, _index

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _viewer(folder: Path, views: list[dict]) -> None:
    folder.mkdir(parents=True)
    body = {"name": folder.name, "kind": "application.web.viewer", "build": ".", "views": views, "module": "viewer.js"}
    (folder / "webapp.json").write_text(json.dumps(body))
    (folder / "viewer.js").write_text("export const viewers = {};\n")


async def _ranked(client, kind: str, names: set[str], **params) -> list[tuple[str, str, str]]:
    resp = await client.get(f"/api/v1/viewers/{kind}", params=params)
    assert resp.json()["status"] == "SUCCESS", resp.text
    # The suite's DB may hold the shipped viewers too; keep only this tree's.
    return [(r["name"], r["why"], r["kind"]) for r in resp.json()["data"] if r["name"] in names]


async def test_viewers_rank_nested_then_specific_kind_then_any(bootstrapped_client, user, tmp_path):
    ns = f"vwtest{uuid.uuid4().hex[:8]}"
    thing, sub = f"{ns}.thing", f"{ns}.thing.sub"
    ds = _dataset(tmp_path, "shown", sub)
    apps = tmp_path / "agentic-assets" / "webapp"
    _viewer(ds / "agentic-assets" / "webapp" / f"own-{ns}", [{"kind": "*"}])
    _viewer(apps / f"specific-{ns}", [{"kind": sub}])
    _viewer(apps / f"family-{ns}", [{"kind": thing, "shows": ["single", "collection"]}])
    _viewer(apps / f"any-{ns}", [{"kind": "*", "shows": ["single", "collection"]}])
    _viewer(apps / f"list-only-{ns}", [{"kind": thing, "shows": ["collection"]}])
    await _index(tmp_path)
    shown = (await _datasets(tmp_path))["shown"]
    names = {f"{n}-{ns}" for n in ("own", "specific", "family", "any", "list-only")}

    assert await _ranked(bootstrapped_client, sub, names, within=shown.typeid) == [
        (f"own-{ns}", "nested", "*"),
        (f"specific-{ns}", "kind", sub),
        (f"family-{ns}", "kind", thing),
        (f"any-{ns}", "any", "*"),
    ], "nested wins; then the longer kind; a collection-only viewer is not offered for one value"
    assert await _ranked(bootstrapped_client, sub, names, shape="collection") == [
        (f"family-{ns}", "kind", thing),
        (f"list-only-{ns}", "kind", thing),
        (f"any-{ns}", "any", "*"),
    ], "outside the dataset its nested viewer is nobody's; ties go by name"

    [best] = [r for r in (await bootstrapped_client.get(f"/api/v1/viewers/{sub}")).json()["data"] if r["name"] == f"specific-{ns}"]
    module = await bootstrapped_client.get(f"/api/v1/graph/service_endpoint/{best['endpoint']}/service/{best['module']}")
    assert module.status_code == 200, module.text
    assert module.headers["content-type"].startswith("text/javascript"), "a browser imports only JavaScript"


async def test_an_app_whose_folder_is_gone_is_never_offered(bootstrapped_client, user, tmp_path):
    ns = f"gone{uuid.uuid4().hex[:8]}"
    ds = _dataset(tmp_path, "shown", f"{ns}.kind")
    _app(ds / "agentic-assets" / "webapp" / f"editor-{ns}")
    _viewer(tmp_path / "agentic-assets" / "webapp" / f"viewer-{ns}", [{"kind": f"{ns}.kind"}])
    await _index(tmp_path)
    shown = (await _datasets(tmp_path))["shown"]
    editors = lambda: bootstrapped_client.get(f"/api/v1/editors/{shown.typeid}")  # noqa: E731
    assert [e["name"] for e in (await editors()).json()["data"]].count(f"editor-{ns}") == 1
    assert await _ranked(bootstrapped_client, f"{ns}.kind", {f"viewer-{ns}"}) == [(f"viewer-{ns}", "kind", f"{ns}.kind")]

    # The folders go; the rows stay until the next index -- and must not be offered meanwhile (a 404).
    shutil.rmtree(ds / "agentic-assets" / "webapp" / f"editor-{ns}")
    shutil.rmtree(tmp_path / "agentic-assets" / "webapp" / f"viewer-{ns}")
    assert f"editor-{ns}" not in [e["name"] for e in (await editors()).json()["data"]]
    assert await _ranked(bootstrapped_client, f"{ns}.kind", {f"viewer-{ns}"}) == []


async def test_a_wildcard_is_not_a_kind_and_is_refused_not_crashed_on(bootstrapped_client, user):
    """`*` once reached this route as a kind and answered 500; a malformed kind is the caller's 400."""
    body = (await bootstrapped_client.get("/api/v1/viewers/*")).json()
    assert body["status"] == "FAIL" and "is not a kind" in body["message"], body
