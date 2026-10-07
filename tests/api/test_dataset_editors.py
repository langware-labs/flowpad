"""Which editor opens a dataset: nested first, then one matching its declared kind, then the generic one.

The real indexer over a tree on disk, then the two reads an editor needs -- ``GET /api/v1/editors``
(ranked) and ``GET /api/v1/kinds`` (the form). Nothing is doubled.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _app(folder: Path, *, edits: list[str] | None = None) -> None:
    folder.mkdir(parents=True)
    body = {"name": folder.name, "title": folder.name, "kind": "application.web.editor", "build": "."}
    if edits is not None:
        body["edits"] = edits
    (folder / "webapp.json").write_text(json.dumps(body))
    (folder / "index.html").write_text("<html></html>")


def _spec(parent: Path, kind: str, body: dict, ns: str) -> Path:
    folder = parent / "agentic-assets" / "data_schema" / kind
    folder.mkdir(parents=True)
    (folder / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns, **body}))
    return folder


def _dataset(root: Path, name: str, spec: str) -> Path:
    ds = root / "agentic-assets" / "dataset" / name
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps({"metadata": {"data_layout": "io_folder", "spec": spec}, "data": {}}))
    return ds


async def _index(root: Path) -> None:
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.record_types import RecordType

    types = {RecordType.DATASET, RecordType.MICRO_APP, RecordType("data_schema")}
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn, frozenset(types))
    await idx.index(IndexerOptions(verbose=False, types=list(types)))


async def _datasets(root: Path) -> dict:
    from flow_sdk.builtin.dataset import Dataset

    under = str(root.resolve())
    return {Path(d.asset_ref).name: d for d in await Dataset.get_all({}) if str(d.asset_ref).startswith(under)}


async def test_editors_rank_nested_then_kind_then_type(bootstrapped_client, user, tmp_path):
    ns = f"edtest{uuid.uuid4().hex[:8]}"
    tag = f"--{ns}--.nav.dataset"
    # The kinds live in the FIRST dataset; the second names the same kind and ships no editor.
    own = _dataset(tmp_path, "with-own-editor", tag)
    top = _spec(own, "nav.dataset", {"examples": {"input": "nav.request", "output": "nav.decision"}}, ns)
    _spec(top, "nav.request", {"fields": {"utterance": {"shape": "string", "description": "what was typed"}}}, ns)
    _spec(
        top, "nav.decision", {"fields": {"route": {"shape": "enum:quick|agentic"}, "target": {"shape": "?string"}}}, ns
    )
    _app(own / "agentic-assets" / "webapp" / "editor")
    _dataset(tmp_path, "without-editor", tag)
    _app(tmp_path / "agentic-assets" / "webapp" / f"nav-editor-{ns}", edits=[f"--{ns}--.nav"])
    _app(tmp_path / "agentic-assets" / "webapp" / f"any-dataset-{ns}", edits=["dataset"])
    await _index(tmp_path)
    found = await _datasets(tmp_path)

    async def ranked(name: str) -> list[tuple[str, str]]:
        resp = await bootstrapped_client.get(f"/api/v1/editors/{found[name].typeid}")
        assert resp.json()["status"] == "SUCCESS", resp.text
        rows = [(r["name"], r["why"]) for r in resp.json()["data"]]
        # The suite's DB may hold other generic dataset editors; keep only this tree's.
        return [r for r in rows if r[0] in {"editor", f"nav-editor-{ns}", f"any-dataset-{ns}"}]

    assert await ranked("with-own-editor") == [
        ("editor", "nested"),
        (f"nav-editor-{ns}", "kind"),
        (f"any-dataset-{ns}", "type"),
    ]
    assert await ranked("without-editor") == [(f"nav-editor-{ns}", "kind"), (f"any-dataset-{ns}", "type")]


async def test_a_kind_reads_as_a_form_with_its_descriptions(bootstrapped_client, user, tmp_path):
    from flow_sdk.schema.data_spec import declared

    ns = f"formtest{uuid.uuid4().hex[:8]}"
    top = _spec(tmp_path, "nav.dataset", {"examples": {"input": "nav.request", "output": "nav.decision"}}, ns)
    _spec(top, "nav.request", {"fields": {"utterance": {"shape": "string", "description": "what was typed"}}}, ns)
    _spec(
        top, "nav.decision", {"fields": {"route": {"shape": "enum:quick|agentic"}, "target": {"shape": "?string"}}}, ns
    )
    assert set(declared.load_root(tmp_path).values()) == {""}

    dataset = (await bootstrapped_client.get(f"/api/v1/kinds/--{ns}--.nav.dataset")).json()["data"]
    assert dataset["subkind"] == "dataset"
    assert dataset["slots"] == {"input": f"--{ns}--.nav.request", "output": f"--{ns}--.nav.decision"}
    decision = (await bootstrapped_client.get(f"/api/v1/kinds/--{ns}--.nav.decision")).json()["data"]
    assert decision["fields"]["route"] == {"shape": "enum:quick|agentic", "description": "", "required": True}
    assert decision["fields"]["target"]["required"] is False
    request = (await bootstrapped_client.get(f"/api/v1/kinds/--{ns}--.nav.request")).json()["data"]
    assert request["fields"]["utterance"]["description"] == "what was typed"
    missing = await bootstrapped_client.get("/api/v1/kinds/nobody.defines.this")
    assert missing.json()["status"] == "FAIL"
