"""A dataset's evals over HTTP: run one, list the runs, read one run joined to its examples.

The toy dataset of ``tests/unit/test_evals`` (its own nested eval marks "ok …" correct, "bad …"
wrong and raises on "boom"), indexed for real, then driven through the dataset's own actions --
the calls the Eval Browser makes.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.dataset import Dataset
from tests.unit.test_evals.test_runner import GOLD, TOY_EVAL

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _toy(client, tmp_path, *, eval_code: str = TOY_EVAL) -> tuple[str, Dataset]:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    folder = tmp_path / "agentic-assets" / "dataset" / "toy"
    folder.mkdir(parents=True)
    (folder / "dataset.json").write_text(
        json.dumps({"metadata": {"title": "Toy", "data_layout": "io_folder", "spec": "navigator.dataset"}, "data": {}})
    )
    info = SchemaRegistry.get("dataset")
    info.mint(info.layout_of(folder, verify=True))
    ev = folder / "agentic-assets" / "eval" / "toy"
    ev.mkdir(parents=True)
    (ev / "eval.json").write_text(json.dumps({"name": "toy", "dataset_kind": "navigator.dataset", "slices": ["data.group"]}))
    (ev / "eval.py").write_text(eval_code)
    ds = Dataset.at(folder)
    await ds.append(
        [
            {"kind": "eval", "input": {"utterance": "ok open it", "here": {"view": "home"}}, "context": {"candidates": []}, "ground_truth": GOLD, "data": {"group": "a"}},
            {"kind": "eval", "input": {"utterance": "bad one"}, "context": {"candidates": []}, "ground_truth": GOLD, "data": {"group": "b"}},
        ]
    )
    resp = await client.post("/api/v1/graph/compute_node/@local/fs-records/invalidate", json={"paths": [str(folder)]})
    assert resp.json()["data"]["minted"] or resp.json()["data"]["reindexed"], resp.text
    return f"/api/v1/graph/dataset/{ds.id}", ds


async def test_run_list_and_read_an_eval(bootstrapped_client, tmp_path):
    base, ds = await _toy(bootstrapped_client, tmp_path)
    assert (await bootstrapped_client.get(f"{base}/evals")).json()["data"] == {"runs": [], "count_metrics": [], "explain": {"toy": {}}}

    ran = (await bootstrapped_client.post(f"{base}/run-eval", json={})).json()
    assert ran["status"] == "SUCCESS", ran
    run_id = ran["data"]["run_id"]
    assert ran["data"]["counts"]["correct"] == 1 and "slices" not in ran["data"]

    [listed] = (await bootstrapped_client.get(f"{base}/evals")).json()["data"]["runs"]
    assert listed["run_id"] == run_id and listed["eval_name"] == "toy"

    body = (await bootstrapped_client.get(f"{base}/eval/{run_id}")).json()["data"]
    assert body["run"]["slices"]["data.group"]["a"]["correct"] == 1
    assert body["count_metrics"] == [], "the toy's metrics are all ratios"
    assert body["explain"] == {}, "the toy explains nothing; the browser falls back to its own words"
    by_title = {e["title"]: e for e in body["examples"]}
    ok = by_title["ok open it"]
    assert ok["verdict"] == "correct" and ok["row_input"]["here"]["view"] == "home", "joined to what was typed, where"
    assert by_title["bad one"]["row_data"] == {"group": "b"}


@pytest.mark.parametrize("run_id", ["nope", "..%2F..%2Fetc"])
async def test_a_run_outside_the_dataset_is_not_found(bootstrapped_client, tmp_path, run_id):
    base, _ = await _toy(bootstrapped_client, tmp_path)
    resp = await bootstrapped_client.get(f"{base}/eval/{run_id}")
    assert resp.status_code == 404


async def test_an_eval_that_cannot_load_is_a_400(bootstrapped_client, tmp_path):
    base, _ = await _toy(bootstrapped_client, tmp_path, eval_code="def nothing(): pass\n")
    resp = await bootstrapped_client.post(f"{base}/run-eval", json={})
    assert resp.status_code == 400 and "evaluate_example" in resp.json()["message"]
