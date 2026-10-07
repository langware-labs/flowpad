"""Reading a dataset's eval runs back: newest first, one broken run never hides the others."""

from __future__ import annotations

import pytest

from flow_sdk.evals import store
from flow_sdk.schema.data_spec.eval_spec import EvalRun, ExampleEval

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


def _run(folder, run_id, started):
    d = folder / "evals" / run_id
    d.mkdir(parents=True)
    run = EvalRun(run_id=run_id, dataset_id="d", dataset_spec="s", eval_name="e", eval_digest="x", started_at=started)
    (d / "run.json").write_text(run.model_dump_json())
    (d / "examples.jsonl").write_text(ExampleEval(example_id="1", verdict="correct").model_dump_json() + "\n")


def test_runs_are_newest_first_and_a_broken_one_is_skipped(tmp_path):
    _run(tmp_path, "old", "2026-10-01T00:00:00+00:00")
    _run(tmp_path, "new", "2026-10-07T00:00:00+00:00")
    (tmp_path / "evals" / "broken").mkdir()
    (tmp_path / "evals" / "broken" / "run.json").write_text("{not json")
    assert [r.run_id for r in store.runs(tmp_path)] == ["new", "old"]


def test_load_reads_one_run_and_refuses_a_path_outside(tmp_path):
    _run(tmp_path, "new", "2026-10-07T00:00:00+00:00")
    run, examples = store.load(tmp_path, "new")
    assert run.run_id == "new" and [e.verdict for e in examples] == ["correct"]
    for bad in ("../new", "missing", ".."):
        with pytest.raises(LookupError):
            store.load(tmp_path, bad)


def test_a_count_survives_the_round_trip_that_json_loses(tmp_path):
    """``1`` and ``1.0`` read the same in a browser, so the run SAYS which metrics are counts."""
    run = EvalRun(run_id="r", dataset_id="d", dataset_spec="s", eval_name="e", eval_digest="x", started_at="t",
                  metrics={"confident_wrong": 1, "precision": 1.0, "missing": None})
    assert EvalRun.model_validate_json(run.model_dump_json()).count_metrics() == ["confident_wrong"]


def test_every_shipped_eval_explains_every_metric_it_declares():
    """A metric without plain words is a column nobody outside the team can read."""
    from flow_sdk.config import flowpad_assistant_project_root
    from flow_sdk.evals.runner import _evals_under

    shipped = _evals_under(flowpad_assistant_project_root())
    assert shipped, "the navigator eval ships"
    for _, spec in shipped:
        assert set(spec.explain) == set(spec.metrics), f"{spec.name}: explain every metric, nothing else"
        assert all(len(text) > 40 for text in spec.explain.values()), f"{spec.name}: say what it means"


def test_explanations_are_read_from_each_evals_own_spec(tmp_path):
    ev = tmp_path / "agentic-assets" / "eval" / "toy"
    ev.mkdir(parents=True)
    (ev / "eval.json").write_text(
        '{"name": "toy", "dataset_kind": "toy.dataset", "metrics": ["m"], "explain": {"m": "what m means"}}'
    )
    assert store.explanations(tmp_path, "toy.dataset") == {"toy": {"m": "what m means"}}
