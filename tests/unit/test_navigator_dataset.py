"""The SmartNavigator dataset: its definitions, its rows, and the evaluation over them.

The row schemas ship as ``data_schema`` folders (``flowpad_assistant/agentic-assets/data_schema/
navigat*``); the rows do not -- they live at ``DATASET`` (``dev/dataset/
smart-navigator`` beside the checkout), and the tests that read them skip where it is absent.
These read it from disk alone -- the same entity indexing builds -- and drive the evaluator with
the decision API doubled at its one seam.
"""

from __future__ import annotations

import subprocess
import sys
from collections import Counter

import pytest

import flow_sdk.decision as decision
from flow_sdk import evals
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core.navigation import DATASET
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult
from flow_sdk.schema.data_spec.navigator_spec import NavigatorRoute

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


@pytest.fixture(scope="module")
def shipped() -> Dataset:
    if not DATASET.is_dir():
        pytest.skip(f"SmartNavigator dataset not at {DATASET}")
    return Dataset.at(DATASET)


def test_the_shipped_dataset_declares_its_rows_and_every_row_fits(shipped):
    assert shipped.spec == "navigator.dataset"
    suites = Counter((r.data or {}).get("suite") for r in shipped.read_rows())
    assert suites == {"benchmark": 52, "ux-surface": 200} and shipped.num_annotated == 252
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


async def test_the_navigator_eval_runs_every_row_on_its_own_context(shipped, monkeypatch, tmp_path):
    """With a decision API that always says 'agentic', only rule hits open -- and every row ran."""

    async def endpoints(**kwargs):
        return [
            APIEndpointOffer(
                id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
            )
        ]

    seen: list = []

    async def decide(spec, *, endpoint=None):
        seen.append(spec.state)
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice="agentic", confidence=0.99),
                "verb": ChoiceAnswer(choice="show", confidence=0.99),
            }
        )

    monkeypatch.setattr(decision, "decision_endpoints", endpoints)
    monkeypatch.setattr(decision, "decide", decide)
    run, folder = await evals.run(shipped, out_dir=tmp_path, concurrency=1)
    benchmark = run.slices["data.suite"].get("benchmark") or run.slices["data.suite"]["—"]
    assert benchmark["examples"] == 50 and benchmark["error"] == 0
    assert benchmark["agentic_recall"] == 1.0 and benchmark["confident_wrong"] == 0
    assert benchmark["precision"] == 1.0, "only exact rule hits opened anything, and they were right"
    assert (folder / "report.html").is_file() and (folder / "examples.jsonl").is_file()
    assert any(st["candidates"] for st in seen), "rows offered their recorded candidates, not this machine's search"
    session = next(st for st in seen if st["page"].startswith("/dock/agentic_process/"))
    assert session["context"]["process"]["title"] == "refactor session", "each row runs where it was typed"
