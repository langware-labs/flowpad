"""The shipped SmartNavigator dataset: its definitions, its rows, and the evaluation over them.

``flow_sdk/system_projects/flowpad_assistant/agentic-assets/dataset/smart-navigator/`` carries
its own row kinds as nested ``data_spec`` folders. These read it from disk alone -- the same entity
indexing builds -- and drive the evaluator with the decision API doubled at its one seam.
"""

from __future__ import annotations

import subprocess
import sys

import pytest

import flow_sdk.decision as decision
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core import navigator_eval
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult
from flow_sdk.schema.data_spec.navigator_spec import NavigatorRoute

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


@pytest.fixture(scope="module")
def shipped() -> Dataset:
    return Dataset.at(navigator_eval.SHIPPED)


def test_the_shipped_dataset_declares_its_rows_and_every_row_fits(shipped):
    assert shipped.spec == "navigator.dataset"
    assert (shipped.num_examples, shipped.kind_counts, shipped.num_annotated) == (52, {"eval": 50, "test": 2}, 52)
    assert shipped.validate_rows() == []
    rows = shipped.read_rows()
    assert rows[0].input.utterance == "open data sources"
    multi = [r for r in rows if isinstance(r.ground_truth, list)]
    assert multi and all(len(r.ground_truth) > 1 for r in multi), "several right answers ride as a list"


def test_a_fresh_process_resolves_the_shipped_kinds_by_name():
    """The kinds are folders, not code: a process that never indexed resolves them on first ask."""
    code = (
        "from flow_sdk.fs_store.schema_registry import SchemaRegistry as R;"
        "t = R.kind_type('navigator.decision'); print(sorted(t.model_fields))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=8)
    assert out.stdout.strip().splitlines()[-1] == "['confidence', 'route', 'target', 'verb']", out.stderr[-500:]


def test_the_decision_kind_is_the_navigators_answer_minus_run_detail():
    """``navigator.decision`` (a folder) and ``NavigatorRoute`` (code) describe one answer; the route
    adds only how it was reached. Drift here means gold and runs stop being comparable."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    declared = set(SchemaRegistry.kind_type("navigator.decision").model_fields)
    assert declared == set(NavigatorRoute.model_fields) - {"reason", "latency_ms"}


def test_metrics_count_precision_coverage_recall_and_confident_wrong(shipped):
    rows = {r.data["case"]: r for r in shipped.read_rows()}
    Dec = shipped.output_shape
    out = lambda **kw: Dec.model_validate(kw)  # noqa: E731
    ran = [
        rows["1"].model_copy(
            update={
                "output": out(
                    route="quick", target={"kind": "view", "value": "data-sources"}, verb="show", confidence=1.0
                )
            }
        ),
        rows["3"].model_copy(
            update={
                "output": out(
                    route="quick", target={"kind": "view", "value": "preferences"}, verb="show", confidence=0.9
                )
            }
        ),
        rows["39"].model_copy(update={"output": out(route="agentic", confidence=0.4)}),
    ]
    m = navigator_eval.metrics(ran)
    assert m["precision"] == 0.5 and m["coverage"] == 0.5 and m["agentic_recall"] == 1.0
    assert m["confident_wrong"] == 1, "a wrong screen at 0.9 is exactly the failure to catch"


async def test_evaluate_runs_every_row_on_its_own_context(shipped, monkeypatch):
    """With a decision API that always says 'agentic', only rule hits open -- and every row ran."""

    async def endpoints(**kwargs):
        return [
            APIEndpointOffer(
                id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
            )
        ]

    seen: list = []

    async def decide(spec, *, endpoint=None):
        seen.append(spec.state["candidates"])
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice="agentic", confidence=0.99),
                "verb": ChoiceAnswer(choice="show", confidence=0.99),
            }
        )

    monkeypatch.setattr(decision, "decision_endpoints", endpoints)
    monkeypatch.setattr(decision, "decide", decide)
    report = await navigator_eval.evaluate(shipped)
    assert report["scored"] == 50 and len(report["outputs"]) == 50
    assert report["agentic_recall"] == 1.0 and report["confident_wrong"] == 0
    assert report["precision"] == 1.0, "only exact rule hits opened anything, and they were right"
    assert any(c for c in seen), "rows offered their recorded candidates, not this machine's search"
