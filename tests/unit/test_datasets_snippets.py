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


@pytest.fixture
def decides_agentic(monkeypatch):
    """A decision API that hands every request to the assistant. Without one nothing is judged: a run
    reports an unanswered decision as an error, never as the navigator's own choice."""

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


@needs_dataset
async def test_evaluate_the_navigator(decides_agentic, tmp_path):
    ns = await run_fence(fence_under(DOC, "2."))
    ns = await run_fence(fence_under(DOC, "4."), {**ns, "runs": tmp_path})
    precision, coverage, recall, confident_wrong = ns["scores"]
    assert recall == 1.0 and confident_wrong == 0 and precision == 1.0


async def test_log_real_decisions_into_a_training_set(tmp_path, monkeypatch, decides_agentic):
    """The decision is logged and labelled as a row, then judged by a run."""
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


@pytest.fixture
def project(tmp_path):
    import uuid

    from flow_sdk.schema.data_spec.declared import load_root

    root = tmp_path / "proj"
    ns = "demo" + uuid.uuid4().hex[:8]   # kinds are process-wide: one namespace per test
    group = root / "agentic-assets/data_schema/crm"
    for kind, fields in (("crm.company", {"name": {"shape": "string"}}),
                         ("crm.lead", {"name": {"shape": "string"}, "company": {"shape": "?crm.company"}})):
        (group / "agentic-assets/data_schema" / kind).mkdir(parents=True)
        (group / "agentic-assets/data_schema" / kind / "data_schema.json").write_text(
            json.dumps({"type": "data_schema", "fields": fields}))
    (group / "data_schema.json").write_text(json.dumps({"type": "data_schema", "ns": ns}))
    assert not any(load_root(root).values())
    for name, kind in (("companies", "crm.company"), ("leads", "crm.lead")):
        folder = root / "agentic-assets/dataset" / name
        folder.mkdir(parents=True)
        (folder / "dataset.json").write_text(json.dumps(
            {"metadata": {"data_layout": "io_folder", "spec": {"examples": [{"input": f"--{ns}--.{kind}"}]}}, "data": {}}))
    return root


async def test_links_between_rows(project):
    ns = await run_fence(fence_under(DOC, "8."), {"project": project})
    assert ns["reason"].startswith("used by --demo") and ns["reason"].endswith(".crm.lead dana")
    assert ns["problems"] and "no --demo" in ns["problems"][0]


async def test_mirror_an_outside_system_and_read_only_what_you_show(project):
    ns = await run_fence(fence_under(DOC, "9."), {"project": project})
    assert ns["done"] == {"created": ["dyne"], "updated": ["bolt"], "unchanged": ["acme"], "deleted": ["core"]}
    assert ns["names"] == ["Bolt Ltd"] and ns["found"]["total"] == 1
    assert ns["tally"] == {"total": 3, "groups": [{"by": {"kind": "train"}, "count": 3}]}
    assert ns["gone"] == ["acme", "dyne"]
