"""NavigationDecision -- a request in, a dock to navigate OR a prompt out -- and SmartNavigationLog.

The decision API is doubled at its two seams (``decision_endpoints`` / ``decide``) and the search at
``navigator._candidates``; the dock building, the log's dataset and its rows are the real ones,
written into this test's instance.
"""

from __future__ import annotations

import asyncio

import pytest

import flow_sdk.decision as decision
from flow_sdk import evals
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core import navigation_log, navigator
from flow_sdk.core.dock_address import parse_dock_url
from flow_sdk.core.navigation_decision import decide
from flow_sdk.preferences import PREF_SMART_NAVIGATION_LOG, write_instance_pref
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

JEV = APIEndpointOffer(id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="h")
SKILL = "skill-2408c41c-b3a4-42fe-8868-243b2ff11aae"
CONV = "conversation-1e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b"
HERE = {"view": "home", "address": "/dock/home"}


@pytest.fixture
def log_temp(tmp_path, monkeypatch):
    """Flowpad's temp folder for this test -- where the log lives."""
    from flow_sdk import config

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path / "flowpad_temp"))
    return tmp_path / "flowpad_temp"


@pytest.fixture
def hub(monkeypatch):
    state = {"endpoints": [JEV], "answer": ("agentic", 0.99)}

    async def _endpoints(**kwargs):
        return state["endpoints"]

    async def _decide(spec, *, endpoint=None):
        key, conf = state["answer"]
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice=key, confidence=conf),
                "verb": ChoiceAnswer(choice="show", confidence=1),
            }
        )

    async def _candidates(utterance):
        return [
            {"typeid": SKILL, "type": "skill", "title": "agent-builder"},
            {"typeid": CONV, "type": "conversation", "title": "Dana"},
        ]

    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    monkeypatch.setattr(decision, "decide", _decide)
    monkeypatch.setattr(navigator, "_candidates", _candidates)
    return state


@pytest.mark.parametrize(
    ("utterance", "answer", "address", "tab"),
    [
        ("open data sources", None, "/dock/data-sources", ("data-sources", "")),  # a rule
        ("search for widget", None, "/dock/search?q=widget", ("search", "")),  # options ride the address
        ("the builder skill", (f"entity:{SKILL}", 0.97), f"/dock/assets/editor/skill/typeid/{SKILL}", None),
        ("dana's chat", (f"entity:{CONV}", 0.97), f"/dock/conversation/{CONV.split('-', 1)[1]}", None),
    ],
)
async def test_a_confident_answer_is_a_dock_to_navigate(hub, utterance, answer, address, tab):
    if answer:
        hub["answer"] = answer
    out = await decide({"utterance": utterance, "here": HERE})
    assert (out.address, out.prompt) == (address, None)
    assert parse_dock_url(out.address) is not None and out.dock is not None
    if tab:
        assert (out.dock.viewType, out.dock.pointer) == tab


@pytest.mark.parametrize(
    ("endpoints", "answer", "reason"),
    [([JEV], ("agentic", 0.99), "agentic"), ([JEV], (f"entity:{SKILL}", 0.6), "unsure"), ([], None, "no_endpoint")],
)
async def test_anything_else_is_the_prompt_unchanged(hub, endpoints, answer, reason):
    hub["endpoints"], hub["answer"] = endpoints, answer or hub["answer"]
    out = await decide({"utterance": "summarize the README", "here": HERE})
    assert (out.prompt, out.address, out.dock, out.decision.route) == ("summarize the README", None, None, "agentic")


async def test_a_file_target_is_navigated_by_the_ui_not_asked(hub):
    out = await decide({"utterance": "open ~/notes/plan.md"})
    assert (out.address, out.prompt, out.decision.target.kind) == (None, None, "file")


# ── SmartNavigationLog ───────────────────────────────────────────────────────


async def _decide_and_log(utterance: str) -> None:
    from flow_sdk.core.navigation_decision import decide_run

    request = {"utterance": utterance, "here": HERE}
    outcome, answer = await decide_run(request)
    navigation_log.log_soon(request, outcome, answer)
    await navigation_log.drain()


async def test_the_log_is_off_by_default_and_writes_nothing(hub, log_temp):
    await _decide_and_log("open data sources")
    assert not navigation_log.folder().exists()


def test_the_log_lives_in_flowpads_temp_folder_per_instance(log_temp):
    """Temp on purpose: the OS clears it now and then, so the log never grows without bound."""
    from flow_sdk.instance_settings import get_instance_settings

    instance = get_instance_settings().instance_name
    assert navigation_log.folder() == log_temp / instance / "agentic-assets" / "dataset" / "smart-navigation-log"


async def test_with_the_log_on_every_decision_is_a_row_of_one_training_set(hub, log_temp):
    write_instance_pref(PREF_SMART_NAVIGATION_LOG, True)
    try:
        await _decide_and_log("open data sources")
        await asyncio.gather(*(_decide_and_log(u) for u in ("summarize the README", "the builder skill", "find x")))
        ds = Dataset.at(navigation_log.folder())
        assert (ds.spec, ds.title, ds.num_examples, ds.kind_counts) == (
            "navigator.dataset",
            "SmartNavigationLog",
            4,
            {"train": 4},
        )
        assert ds.validate_rows() == []
        rows = {r.input.utterance: r for r in ds.read_rows()}
        opened, asked = rows["open data sources"], rows["summarize the README"]
        assert (opened.input.here.view, opened.output.route, opened.data["address"]) == (
            "home",
            "quick",
            "/dock/data-sources",
        )
        assert (asked.output.route, asked.data["prompt"], asked.ground_truth) == (
            "agentic",
            "summarize the README",
            None,
        )
        assert [c.typeid for c in asked.context.candidates] == [SKILL, CONV], "what the decision was offered"
        # How it was decided is kept with the row -- a rule hit asked no model, so it says only that.
        assert opened.data["run"] == {"reason": "rule"}
        decided = asked.data["run"]["decision"]
        assert decided["request"]["state"]["utterance"] == "summarize the README"
        assert "target" in decided["response"]["answers"]

        # the data scientist's path: label one row, evaluate the labelled training rows
        await ds.annotate(opened.id, opened.output.model_dump(mode="json", exclude_none=True))
        log_temp_runs = navigation_log.folder().parent / "runs"
        run, _ = await evals.run(Dataset.at(navigation_log.folder()), kinds=["train"], out_dir=log_temp_runs)
        assert (run.examples, run.counts["unlabelled"], run.metrics["precision"]) == (1, 3, 1.0)
    finally:
        write_instance_pref(PREF_SMART_NAVIGATION_LOG, False)
