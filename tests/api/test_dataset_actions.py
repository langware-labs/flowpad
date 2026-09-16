"""The curation seam over HTTP: a dataset bound to a source takes its items as
examples (``promote``) and gold labels (``annotate``); counts follow the disk."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio

SHAPE = {"examples": [{"input": "ingest.source_item", "output": {"sentiment": "string"}}]}


async def _project(client, tmp_path) -> str:
    resp = await client.post("/api/v1/graph/project", json={"type": "project", "name": "curate", "fs_storage_mount_path": str(tmp_path)})
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["id"]


async def _source_with_items(client, n: int = 2) -> str:
    resp = await client.post("/api/v1/graph/data_source", json={"name": "feed", "provider": "rss", "kind": "content.feed", "config": {"feed_urls": ["http://127.0.0.1:1/x"]}})
    assert resp.json().get("status") == "SUCCESS", resp.text
    sid = resp.json()["data"]["id"]
    items = [{"data_source_id": sid, "provider": "rss", "kind": "content.feed.item", "segment_key": "http://127.0.0.1:1/x",
              "external_id": f"e{i}", "name": f"Post {i}", "body": f"body {i}"} for i in range(n)]
    resp = await client.post("/api/v1/ingest/items", json={"items": items})
    assert resp.status_code == 200, resp.text
    return sid


async def _items(client, sid: str) -> list[dict]:
    resp = await client.get("/api/v1/graph/source_item", params={"filter": json.dumps({"data_source_id": sid})})
    return resp.json()["data"]


async def _dataset(client, pid: str, sid: str, **extra) -> dict:
    body = {"type": "dataset", "name": "labels", "title": "Labels", "data_layout": "io_folder", "source_id": sid, "spec": SHAPE, **extra}
    resp = await client.post(f"/api/v1/graph/project/{pid}/dataset", json=body)
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]


async def test_promote_then_annotate_lands_on_disk_and_in_counts(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    pid = await _project(client, tmp_path)
    sid = await _source_with_items(client)
    ds = await _dataset(client, pid, sid)
    assert ds["source_id"] == sid and ds["spec"] == SHAPE
    folder = Path(ds["asset_ref"])
    assert (folder / "dataset.json").is_file()
    manifest = json.loads((folder / "dataset.json").read_text())["metadata"]
    assert manifest["source_id"] == sid, "the binding is authored in the manifest"

    items = await _items(client, sid)
    resp = await client.post(f"/api/v1/graph/dataset/{ds['id']}/promote", json={"source_item_ids": [items[0]["id"]]})
    assert resp.status_code == 200, resp.text
    [eid] = resp.json()["data"]["example_ids"]
    assert resp.json()["data"]["num_examples"] == 1
    item_doc = json.loads((folder / "examples" / "0001" / "input" / "item.json").read_text())
    assert item_doc["external_id"] == items[0]["external_id"] and item_doc["body"] == items[0]["body"]

    resp = await client.post(f"/api/v1/graph/dataset/{ds['id']}/annotate", json={"example_id": eid, "ground_truth": {"sentiment": "positive"}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["num_annotated"] == 1
    assert json.loads((folder / "examples" / "0001" / "ground_truth" / "label.json").read_text()) == {"sentiment": "positive"}

    row = (await client.get(f"/api/v1/graph/dataset/{ds['id']}")).json()["data"]
    assert row["num_examples"] == 1 and row["num_annotated"] == 1
    listed = (await client.get("/api/v1/graph/dataset", params={"filter": json.dumps({"source_id": sid})})).json()["data"]
    assert [d["id"] for d in listed] == [ds["id"]]


async def test_shape_and_layout_are_enforced(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    pid = await _project(client, tmp_path)
    sid = await _source_with_items(client, 1)
    ds = await _dataset(client, pid, sid)
    [item] = await _items(client, sid)
    [eid] = (await client.post(f"/api/v1/graph/dataset/{ds['id']}/promote", json={"source_item_ids": [item["id"]]})).json()["data"]["example_ids"]

    bad = await client.post(f"/api/v1/graph/dataset/{ds['id']}/annotate", json={"example_id": eid, "ground_truth": {"mood": "x"}})
    assert bad.status_code == 400 and "schema" in bad.json()["data"], bad.text
    missing = await client.post(f"/api/v1/graph/dataset/{ds['id']}/annotate", json={"example_id": "nope", "ground_truth": {"sentiment": "p"}})
    assert missing.status_code == 404

    csv_ds = await _dataset(client, pid, sid, name="csvset", data_layout="csv")
    refused = await client.post(f"/api/v1/graph/dataset/{csv_ds['id']}/promote", json={"source_item_ids": [item["id"]]})
    assert refused.status_code == 400 and "io_folder" in refused.json()["message"]

    plain = await _dataset(client, pid, sid, name="plain", spec=None)
    refused = await client.post(f"/api/v1/graph/dataset/{plain['id']}/promote", json={"source_item_ids": [item["id"]]})
    assert refused.status_code == 400 and "ingest.source_item" in refused.json()["message"]


async def test_examples_listing_reports_promoted_items_and_gold(bootstrapped_client, user, tmp_path):
    client = bootstrapped_client
    pid = await _project(client, tmp_path)
    sid = await _source_with_items(client, 2)
    ds = await _dataset(client, pid, sid)
    items = await _items(client, sid)
    [eid] = (await client.post(f"/api/v1/graph/dataset/{ds['id']}/promote", json={"source_item_ids": [items[0]["id"]]})).json()["data"]["example_ids"]
    listed = (await client.get(f"/api/v1/graph/dataset/{ds['id']}/examples")).json()["data"]["examples"]
    assert listed == [{"example_id": eid, "item_id": items[0]["id"], "kind": "train", "annotated": False}]
    await client.post(f"/api/v1/graph/dataset/{ds['id']}/annotate", json={"example_id": eid, "ground_truth": {"sentiment": "neutral"}})
    listed = (await client.get(f"/api/v1/graph/dataset/{ds['id']}/examples")).json()["data"]["examples"]
    assert listed[0]["annotated"] is True
