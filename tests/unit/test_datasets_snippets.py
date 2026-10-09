"""``docs/snippets/datasets.md``: every Python fence, run as written.

The SmartNavigator dataset is read from disk (skipped where it is absent); §3 writes into a fresh dataset folder
whose spec names the shipped kind; §4 doubles the decision API at its one seam.
"""

from __future__ import annotations

import json

import pytest

import flow_sdk.decision as decision
from flow_sdk.core.navigation import DATASET
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult
from tests.utils.snippets import SHELF, fence_under, run_fence

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

DOC = (SHELF / "datasets.md").read_text(encoding="utf-8")
needs_dataset = pytest.mark.skipif(not DATASET.is_dir(), reason=f"SmartNavigator dataset not at {DATASET}")


@pytest.fixture
def folder(tmp_path):
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    ds = tmp_path / "agentic-assets" / "dataset" / "mine"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(
        json.dumps({"metadata": {"data_layout": "io_folder", "spec": "navigator.dataset"}, "data": {}})
    )
    info = SchemaRegistry.get("dataset")
    info.mint(info.layout_of(ds, verify=True))
    return ds


@needs_dataset
async def test_read_a_dataset():
    ns = await run_fence(fence_under(DOC, "2."))
    assert ns["summary"] == ("navigator.dataset", 252, {"eval": 250, "test": 2})
    assert ns["first"] == "open data sources" and ns["problems"] == []


async def test_write_rows_and_labels(folder):
    ns = await run_fence(fence_under(DOC, "3."), {"folder": folder})
    assert [g["target"]["value"] for g in ns["gold"]] == ["data-sources", "connectors"]
    assert (folder / "examples/0001/ground_truth-2/decision.json").is_file()


@needs_dataset
async def test_evaluate_the_navigator(monkeypatch, tmp_path):
    async def endpoints(**kwargs):
        return [
            APIEndpointOffer(
                id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
            )
        ]

    async def decide(spec, *, endpoint=None):
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice="agentic", confidence=0.99),
                "verb": ChoiceAnswer(choice="show", confidence=0.99),
            }
        )

    monkeypatch.setattr(decision, "decision_endpoints", endpoints)
    monkeypatch.setattr(decision, "decide", decide)
    ns = await run_fence(fence_under(DOC, "2."))
    ns = await run_fence(fence_under(DOC, "4."), {**ns, "runs": tmp_path})
    precision, coverage, recall, confident_wrong = ns["scores"]
    assert recall == 1.0 and confident_wrong == 0 and precision == 1.0


async def test_log_real_decisions_into_a_training_set(tmp_path, monkeypatch):
    """No decision API in this tier: the decision is the prompt, logged and labelled as a row."""
    from flow_sdk import config

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path))
    ns = await run_fence(fence_under(DOC, "6."), {"runs": tmp_path})
    assert ns["logged"] == ("summarize the README", "agentic", "summarize the README")
    assert ns["run"].examples >= 1 and ns["run"].metrics["agentic_recall"] == 1.0


async def test_keep_records_by_key(folder):
    ns = await run_fence(fence_under(DOC, "7."), {"folder": folder})
    assert ns["keys"] == ["sources"]
    assert ns["problems"] and ns["problems"][0].startswith("input.utterance:")
    assert not (folder / "examples/sources").exists()
