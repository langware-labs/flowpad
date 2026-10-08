"""The generic eval runner over a toy dataset whose own nested eval judges its rows.

The dataset declares ``navigator.dataset`` (a shipped kind), so the shipped navigator eval ALSO
matches it -- the nested one must win. Its ``eval.py`` marks "ok …" correct, "bad …" wrong and
raises on "boom", so one run exercises every verdict the runner records.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk import evals
from flow_sdk.builtin.dataset import Dataset

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

TOY_EVAL = '''
from flow_sdk.evals import EvalTrace, ExampleEval, verdict_of

async def evaluate_example(row):
    text = row.input.utterance
    if text.startswith("boom"):
        raise RuntimeError("the eval broke on this row")
    pred = {"route": "quick", "target": {"kind": "view", "value": "data-sources" if text.startswith("ok") else "home"}}
    return ExampleEval(
        prediction=pred, verdict=verdict_of(pred, row), score=0.9, labels={"len": str(len(text) > 6)},
        trace=EvalTrace(kind="toy.trace", value={"saw": text}),
    )

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


async def test_a_version_given_as_a_value_is_kept_once_in_the_dataset(toy, tmp_path):
    # The navigator's map: a value of a schema, so the run names the exact version it offered.
    from flow_sdk.core.navigation import navigation_map
    from flow_sdk.values import resolve_ref, store_of

    (Path(toy.asset_ref) / "agentic-assets" / "eval" / "toy" / "eval.py").write_text(
        TOY_EVAL.replace('return {"engine": "toy"}', 'from flow_sdk.core.navigation import navigation_map\n    return {"map": navigation_map()}')
    )
    first, _ = await evals.run(toy, out_dir=tmp_path / "runs")
    again, _ = await evals.run(toy, out_dir=tmp_path / "runs-2")
    assert first.versions["map"].startswith("navigation.map.id.") and again.versions == first.versions
    assert resolve_ref(first.versions["map"], near=store_of(toy.asset_ref)) == navigation_map()


async def test_the_navigator_eval_counts_an_unanswered_decision_as_an_error(tmp_path):
    # A request no rule answers goes to the decision API; with none to answer (no endpoint here, a
    # spent quota live) nothing was judged -- an error with the API's reason, never an abstention
    # that would pass for the navigator handing the request over.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    folder = tmp_path / "agentic-assets" / "dataset" / "nav"
    folder.mkdir(parents=True)
    (folder / "dataset.json").write_text(
        json.dumps({"metadata": {"title": "Nav", "data_layout": "io_folder", "spec": "navigator.dataset"}, "data": {}})
    )
    info = SchemaRegistry.get("dataset")
    info.mint(info.layout_of(folder, verify=True))
    here = {"view": "home", "page": "desk", "address": "/dock/home"}
    await Dataset.at(folder).append(
        [{"kind": "eval", "input": {"utterance": "how is my week looking", "here": here}, "context": {"candidates": []}, "ground_truth": GOLD}]
    )
    run, out = await evals.run(Dataset.at(folder), out_dir=tmp_path / "runs")
    assert run.eval_name == "navigator" and run.counts["error"] == 1 and run.counts["abstained"] == 0
    [row] = [json.loads(line) for line in (out / "examples.jsonl").read_text().splitlines()]
    assert row["error"].startswith("decision API: no_endpoint") and row["trace"]["kind"] == "navigator.run"


async def test_two_runs_compare_example_by_example(toy, tmp_path):
    # The second run judges "bad one" right: one fixed, nothing broken.
    from flow_sdk.evals.compare import compare
    from flow_sdk.evals.store import load

    first, out1 = await evals.run(toy, out_dir=tmp_path / "evals")
    eval_py = Path(toy.asset_ref) / "agentic-assets" / "eval" / "toy" / "eval.py"
    eval_py.write_text(TOY_EVAL.replace('text.startswith("ok")', 'text.startswith(("ok", "bad"))'))
    second, out2 = await evals.run(toy, out_dir=tmp_path / "evals")
    assert first.kinds == second.kinds == ["eval"]
    diff = compare(load(tmp_path, first.run_id), load(tmp_path, second.run_id))
    # "boom" errors in both runs: not judged, so not "still wrong" either.
    assert ([e.title for e in diff.fixed], diff.broken, diff.still_wrong, diff.paired, diff.unjudged) == (["bad one"], [], 0, 2, 1)
    assert diff.deltas["accuracy"] == 0.5


async def test_an_error_on_either_side_is_neither_fixed_nor_broken(toy, tmp_path):
    # A run the API refused judged nothing: comparing it must not report the refused rows as broken.
    from flow_sdk.evals.compare import compare
    from flow_sdk.evals.store import load

    first, _ = await evals.run(toy, out_dir=tmp_path / "evals")
    eval_py = Path(toy.asset_ref) / "agentic-assets" / "eval" / "toy" / "eval.py"
    eval_py.write_text(TOY_EVAL.replace('if text.startswith("boom"):', 'if True:'))
    refused, _ = await evals.run(toy, out_dir=tmp_path / "evals")
    diff = compare(load(tmp_path, first.run_id), load(tmp_path, refused.run_id))
    assert (diff.broken, diff.fixed, diff.unjudged, diff.paired) == ([], [], 3, 0)


def test_agentic_recall_counts_only_requests_that_belong_to_the_assistant_alone():
    # "restart this session" accepts the assistant OR the restart action: acting is right, so the row
    # must not pull the assistant's recall down.
    import importlib.util

    from flow_sdk.schema.data_spec.eval_spec import ExampleEval, Verdict

    path = Path(evals.__file__).resolve().parents[1] / "system_projects/flowpad_assistant/agentic-assets/eval/navigator/eval.py"
    spec = importlib.util.spec_from_file_location("navigator_eval_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    acted = {"route": "quick", "target": {"kind": "action", "value": "restart-session"}}
    both = ExampleEval(verdict=Verdict.CORRECT, prediction=acted, golds=[{"route": "agentic"}, acted], score=0.9)
    alone = ExampleEval(verdict=Verdict.CORRECT, prediction={"route": "agentic"}, golds=[{"route": "agentic"}])
    assert module.aggregate([both, alone])["agentic_recall"] == 1.0
