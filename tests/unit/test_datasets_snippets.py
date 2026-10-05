"""``docs/snippets/datasets.md``: every Python fence, run as written.

The shipped SmartNavigator dataset is read from disk; §3 writes into a fresh dataset folder
whose spec names the shipped kind; §4 doubles the decision API at its one seam.
"""

from __future__ import annotations

import json

import pytest

import flow_sdk.decision as decision
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult
from tests.utils.snippets import SHELF, fence_under, run_fence

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

DOC = (SHELF / "datasets.md").read_text(encoding="utf-8")


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


async def test_read_a_dataset():
    ns = await run_fence(fence_under(DOC, "2."))
    assert ns["summary"] == ("navigator.dataset", 52, {"eval": 50, "test": 2})
    assert ns["first"] == "open data sources" and ns["problems"] == []


async def test_write_rows_and_labels(folder):
    ns = await run_fence(fence_under(DOC, "3."), {"folder": folder})
    assert [g["target"]["value"] for g in ns["gold"]] == ["data-sources", "connectors"]
    assert (folder / "examples/0001/ground_truth-2/decision.json").is_file()


async def test_evaluate_the_navigator(monkeypatch):
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
    ns = await run_fence(fence_under(DOC, "4."), ns)
    precision, coverage, recall, confident_wrong = ns["scores"]
    assert recall == 1.0 and confident_wrong == 0 and precision == 1.0
