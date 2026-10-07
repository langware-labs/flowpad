"""The generic eval runner over a toy dataset whose own nested eval judges its rows.

The dataset declares ``navigator.dataset`` (a shipped kind), so the shipped navigator eval ALSO
matches it -- the nested one must win. Its ``eval.py`` marks "ok …" correct, "bad …" wrong and
raises on "boom", so one run exercises every verdict the runner records.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk import evals
from flow_sdk.builtin.dataset import Dataset

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

TOY_EVAL = '''
from flow_sdk.evals import ExampleEval, verdict_of

async def evaluate_example(row):
    text = row.input.utterance
    if text.startswith("boom"):
        raise RuntimeError("the eval broke on this row")
    pred = {"route": "quick", "target": {"kind": "view", "value": "data-sources" if text.startswith("ok") else "home"}}
    return ExampleEval(prediction=pred, verdict=verdict_of(pred, row), score=0.9, labels={"len": str(len(text) > 6)})

def aggregate(results):
    return {"seen": float(len(results))}

def versions():
    return {"engine": "toy"}
'''
GOLD = {"route": "quick", "target": {"kind": "view", "value": "data-sources"}}


@pytest.fixture
async def toy(tmp_path):
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
    (ev / "eval.json").write_text(
        json.dumps({"name": "toy", "dataset_kind": "navigator.dataset", "metrics": ["seen"], "slices": ["data.group", "labels.len"]})
    )
    (ev / "eval.py").write_text(TOY_EVAL)
    ds = Dataset.at(folder)
    await ds.append(
        [
            {"kind": "eval", "input": {"utterance": "ok open it"}, "context": {"candidates": []}, "ground_truth": GOLD, "data": {"group": "a"}},
            {"kind": "eval", "input": {"utterance": "bad one"}, "context": {"candidates": []}, "ground_truth": GOLD, "data": {"group": "a"}},
            {"kind": "eval", "input": {"utterance": "boom"}, "context": {"candidates": []}, "ground_truth": GOLD, "data": {"group": "b"}},
            {"kind": "eval", "input": {"utterance": "no label yet"}, "context": {"candidates": []}, "data": {"group": "b"}},
        ]
    )
    return Dataset.at(folder)


async def test_a_run_judges_every_labelled_row_and_records_it(toy, tmp_path):
    run, out = await evals.run(toy, out_dir=tmp_path / "runs")
    assert (run.eval_name, run.examples, run.versions) == ("toy", 3, {"engine": "toy"}), "the nested eval, not the shipped one"
    assert run.counts == {"correct": 1, "wrong": 1, "abstained": 0, "error": 1, "unlabelled": 1}
    assert run.metrics["accuracy"] == 0.5 and run.metrics["seen"] == 3.0, "errors are not judged; aggregate is the eval's"
    rows = [json.loads(line) for line in (out / "examples.jsonl").read_text().splitlines()]
    boom = next(r for r in rows if r["title"] == "boom")
    assert boom["verdict"] == "error" and "the eval broke" in boom["error"], "one bad row is a verdict, not a crash"
    assert {r["slice"]["data.group"] for r in rows} == {"a", "b"} and run.slices["labels.len"]["True"]["examples"] == 2
    assert all(len(r["golds"]) == 1 and r["golds"][0]["target"] == GOLD["target"] for r in rows)
    assert json.loads((out / "run.json").read_text())["run_id"] == run.run_id


async def test_the_report_is_one_page_with_every_example(toy, tmp_path):
    _, out = await evals.run(toy, out_dir=tmp_path / "runs")
    page = (out / "report.html").read_text()
    assert page.startswith("<!doctype html>") and "<script" in page and "http" not in page.split("<body>")[1].split("<script")[0]
    for title in ("ok open it", "bad one", "boom"):
        assert title in page


async def test_no_eval_for_a_dataset_is_an_error_not_a_crash(toy, tmp_path):
    with pytest.raises(evals.EvalError, match="no eval"):
        await evals.run(toy, eval_name="nonexistent", out_dir=tmp_path / "runs")
