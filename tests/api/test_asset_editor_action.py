"""``GET /api/v1/graph/<type>/<id>/editor/<name>/…`` — an asset's editor app is
served by the same implementation as a MicroApp (``serve_app_bytes``): the
document gets the API origin its SDK needs, deep paths fall back to index.html,
and nothing outside the editor folder is reachable."""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.faas.serve_static import API_ORIGIN_SNIPPET
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.asyncio


def _write_skill(root: Path, name: str, sid: str, *, editor: str | None = "curate") -> Path:
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(f"---\nid: {sid}\nname: {name}\ndescription: d\n---\n\n# {name}\n")
    if editor:
        app = folder / "editors" / editor
        app.mkdir(parents=True)
        (app / "index.html").write_text("<html><head><title>Curate</title></head><body>curate</body></html>")
        (app / "app.js").write_text("console.log('curate')")
    (folder / "outside.txt").write_text("OUTSIDE THE EDITOR")
    return folder


async def _index(root: Path) -> None:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.SKILL]))


def _url(sid: str, tail: str = "") -> str:
    return f"/api/v1/graph/skill/{sid}/editor/{tail}"


async def test_editor_is_served_with_api_origin_and_listed_on_the_row(bootstrapped_client, user, tmp_path):
    sid = str(uuid.uuid4())
    _write_skill(tmp_path, "curated", sid)
    await _index(tmp_path)

    entity = await bootstrapped_client.get(f"/api/v1/graph/skill/{sid}")
    assert entity.status_code == 200, entity.text
    assert entity.json()["data"]["editors"] == ["curate"]

    resp = await bootstrapped_client.get(_url(sid, "curate/"))
    assert resp.status_code == 200, resp.text
    assert "curate" in resp.text and API_ORIGIN_SNIPPET in resp.text and "<base" in resp.text

    asset = await bootstrapped_client.get(_url(sid, "curate/app.js"))
    assert asset.status_code == 200 and "console.log" in asset.text

    deep = await bootstrapped_client.get(_url(sid, "curate/some/router/path"))
    assert deep.status_code == 200 and "curate" in deep.text, "SPA deep link falls back to index"


async def test_unknown_or_malformed_editor_is_a_404_and_traversal_is_refused(bootstrapped_client, user, tmp_path):
    sid = str(uuid.uuid4())
    _write_skill(tmp_path, "plain", sid)
    await _index(tmp_path)

    assert (await bootstrapped_client.get(_url(sid, "nope/"))).status_code == 404
    assert (await bootstrapped_client.get(_url(sid, "..%2Fcurate/"))).status_code == 404
    escaped = await bootstrapped_client.get(_url(sid, "curate/../outside.txt"))
    assert escaped.status_code in (403, 404) and "OUTSIDE" not in escaped.text


async def test_a_row_without_an_asset_has_no_editor(bootstrapped_client, user):
    from flow_sdk.builtin.task import Task  # noqa: PLC0415

    task = Task(title="no asset")
    await task.save()
    assert (await bootstrapped_client.get(f"/api/v1/graph/task/{task.id}/editor/spec/")).status_code == 404
