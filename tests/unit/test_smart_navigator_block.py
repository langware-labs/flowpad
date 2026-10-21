"""The Smart Navigator is a FlowCall block: ``navigator.request`` in, a ``ReturnedValue`` holding a
``navigation.outcome`` out. Both answers -- a dock to open and the prompt for the assistant -- are OK;
bad input raises before the call runs. The decision API is doubled at its two seams."""

from __future__ import annotations

import pytest

import flow_sdk.decision as decision
from flow_sdk.core import navigation_decision
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.core.compute.declared_value import DeclaredShapeError
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

JEV = APIEndpointOffer(id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="h")


@pytest.fixture
def answers(monkeypatch):
    """The decision API answers ``target`` with whatever the test puts in the list."""
    picked: list[str] = []

    async def _endpoints(**kwargs):
        return [JEV]

    async def _decide(spec, *, endpoint=None):
        return DecisionResult(answers={"target": ChoiceAnswer(choice=picked[0], confidence=0.99)})

    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    monkeypatch.setattr(decision, "decide", _decide)
    return picked


def test_the_block_declares_the_navigator_kinds():
    spec = ComputeOpSpec.model_validate_json((navigation_decision.BLOCK / "compute_op.json").read_text())
    assert (spec.name, spec.subkind.value) == ("smart-navigator", "python")
    assert (spec.input, spec.output) == ("navigator.request", "navigation.outcome")


@pytest.mark.asyncio
async def test_a_screen_is_an_ok_answer_with_its_dock(answers):
    answer = await navigation_decision.call({"utterance": "open data sources", "here": {"view": "home"}})
    assert answer.exit_code == ExitCode.OK and answer.has_value
    assert answer.value.address == "/dock/data-sources"
    assert answer.value.prompt is None


@pytest.mark.asyncio
async def test_handing_over_to_the_assistant_is_an_ok_answer_too(answers):
    answers.append("agentic")
    answer = await navigation_decision.call({"utterance": "summarize the README"})
    assert answer.exit_code == ExitCode.OK
    assert answer.value.prompt == "summarize the README"
    assert answer.value.address is None


@pytest.mark.asyncio
async def test_bad_input_is_refused_before_the_call_runs():
    with pytest.raises(DeclaredShapeError):
        await navigation_decision.call({"here": {"view": "home"}})


@pytest.mark.asyncio
async def test_the_answer_says_how_it_was_decided(answers):
    from flow_sdk.schema.data_spec.navigator_spec import NavigatorResult

    answers.append("agentic")
    answer = await navigation_decision.call({"utterance": "summarize the README"})
    assert isinstance(answer, NavigatorResult)
    assert answer.reason and answer.run is not None, "the eval and the log read these"


@pytest.mark.asyncio
async def test_replay_offers_the_recorded_matches_instead_of_searching(answers, monkeypatch):
    from flow_sdk.core import navigator

    async def _no_search(utterance):
        raise AssertionError("a replayed request searched")

    monkeypatch.setattr(navigator, "_candidates", _no_search)
    answers.append("agentic")
    recorded = [{"typeid": "task-2408c41c-b3a4-42fe-8868-243b2ff11aae", "type": "task", "title": "Ship it"}]
    answer = await navigation_decision.call({"utterance": "the ship task", "replay": {"candidates": recorded}})
    assert [c.model_dump(mode="json", exclude_none=True) for c in answer.value.candidates] == recorded


@pytest.mark.asyncio
async def test_the_block_log_keeps_a_live_decision_but_not_a_replay(answers, tmp_path, monkeypatch):
    """SmartNavigationLog is the block's FlowCall log: on with its preference, one row per live decision."""
    from flow_sdk import config
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.core import navigation_log
    from flow_sdk.preferences import PREF_SMART_NAVIGATION_LOG, write_instance_pref

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path / "temp"))
    spec = ComputeOpSpec.model_validate_json((navigation_decision.BLOCK / "compute_op.json").read_text())
    assert (spec.log.name, spec.log.enabled_by) == (navigation_log.NAME, PREF_SMART_NAVIGATION_LOG)
    answers.extend(["agentic"] * 3)
    await navigation_decision.call({"utterance": "while off"})
    await navigation_log.drain()
    assert not navigation_log.folder().exists(), "off unless its preference is on"
    write_instance_pref(PREF_SMART_NAVIGATION_LOG, True)
    try:
        await navigation_decision.call({"utterance": "live one"})
        await navigation_decision.call({"utterance": "replayed one", "replay": {"candidates": []}})
        await navigation_log.drain()
    finally:
        write_instance_pref(PREF_SMART_NAVIGATION_LOG, False)
    from flow_sdk.core.log_dataset import rows

    log = Dataset.at(navigation_log.folder())
    [row] = [log.row(d.name) for d in rows(navigation_log.folder())]
    assert row["input"]["utterance"] == "live one", "an eval replay is no decision -- it must not land in the log"
    assert row["output"]["route"] == "agentic"
    assert row["data"]["block"] == "smart-navigator" and row["data"]["invocation_id"], "the run's trace rides along"
