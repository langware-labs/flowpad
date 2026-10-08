"""One stored value by its reference: ``GET /api/v1/values/<kind>.id.<uuid>?within=<the asset keeping it>``.

A dataset on disk, indexed by the real indexer, keeps a navigation map version in its own
``agentic-assets/value``; the read answers it, and the kind route answers the reference's form.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.core.navigation import navigation_map
from flow_sdk.values import save_value, store_of

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

OTHER = "navigation.map.id.7c1e2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"


async def _dataset(root: Path) -> str:
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.record_types import RecordType

    ds = root / "agentic-assets" / "dataset" / "nav"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps({"metadata": {"data_layout": "io_folder", "spec": "navigator.dataset"}, "data": {}}))
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn, frozenset({RecordType.DATASET}))
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.DATASET]))
    under = str(root.resolve())
    found = [d for d in await Dataset.get_all({}) if str(d.asset_ref).startswith(under)]
    return f"dataset-{found[0].id}"


async def test_a_reference_reads_the_value_its_asset_keeps(bootstrapped_client, user, tmp_path):
    within = await _dataset(tmp_path)
    ref = save_value(navigation_map(), store_of(tmp_path / "agentic-assets" / "dataset" / "nav"))

    got = (await bootstrapped_client.get(f"/api/v1/values/{ref}", params={"within": within})).json()
    assert got["status"] == "SUCCESS", got
    assert got["data"]["kind"] == "navigation.map" and got["data"]["ref"] == ref
    assert got["data"]["value"] == navigation_map().model_dump(mode="json")

    missing = (await bootstrapped_client.get(f"/api/v1/values/{OTHER}", params={"within": within})).json()
    assert missing["status"] == "FAIL" and "no value" in missing["message"]
    malformed = (await bootstrapped_client.get("/api/v1/values/navigation.map", params={"within": within})).json()
    assert malformed["status"] == "FAIL" and "not a reference" in malformed["message"]


async def test_a_reference_has_its_kind_s_form(bootstrapped_client, user):
    form = (await bootstrapped_client.get(f"/api/v1/kinds/{OTHER}")).json()["data"]
    assert form["kind"] == "navigation.map" and "places" in form["fields"]
