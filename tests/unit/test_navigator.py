"""The navigator: open something now, or hand the request to the assistant.

``decide`` and the endpoint listing are doubled; what is under test is the cascade and its
contract -- off without a decision API, rules before the model, a confident answer opens,
anything else is ``agentic``. The live numbers (50 cases x 3 through ``route()``, Jev via the
local hub: 100% precision, 92% coverage, 0 confident-wrong, P95 329 ms) are the benchmark's.
"""

from __future__ import annotations

import pytest

import flow_sdk.decision as decision
from flow_sdk.core import navigation, navigator
from flow_sdk.core.dock_address import parse_dock_url
from flow_sdk.external_apis.decision import DecisionError
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

JEV = APIEndpointOffer(
    id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
)
TASK = "task-8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e"


@pytest.fixture
def hub(monkeypatch):
    """A decision API exists; ``decide`` answers ``state['answer']``; records every spec it got."""
    state = {"endpoints": [JEV], "answer": None, "error": None, "specs": []}

    async def _endpoints(**kwargs):
        return state["endpoints"]

    async def _decide(spec, *, endpoint=None):
        state["specs"].append(spec)
        if state["error"]:
            raise state["error"]
        key, conf, verb = state["answer"]
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice=key, confidence=conf),
                "verb": ChoiceAnswer(choice=verb, confidence=0.99),
            }
        )

    async def _candidates(utterance):
        return [{"typeid": TASK, "type": "task", "title": "Zoom OAuth on dev"}]

    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    monkeypatch.setattr(decision, "decide", _decide)
    monkeypatch.setattr(navigator, "_candidates", _candidates)
    return state


async def test_without_a_decision_api_every_ask_is_todays_even_an_exact_screen_name(hub):
    hub["endpoints"] = []
    r = await navigator.route("data sources")
    assert (r.route, r.reason) == ("agentic", "no_endpoint") and hub["specs"] == []


@pytest.mark.parametrize(
    ("utterance", "kind", "value", "verb"),
    [
        ("open data sources", "view", "data-sources", "show"),
        ("connections", "view", "credentials", "show"),  # an alias, not the slug it resembles
        ("take me to preferences", "view", "preferences", "navigate"),
        ("open https://linear.app", "url", "https://linear.app", "show"),
        ("open the app on port 5173", "webapp", "5173", "show"),
        ("search for widget", "view", "search?q=widget", "show"),
        ("open ~/notes/plan.md", "file", "~/notes/plan.md", "show"),
    ],
)
async def test_a_rule_answers_before_the_model(hub, utterance, kind, value, verb):
    r = await navigator.route(utterance)
    assert (r.route, r.target.kind, r.target.value, r.verb, r.reason) == ("quick", kind, value, verb, "rule")
    assert hub["specs"] == [], "a rule hit never spends a decision"


async def test_a_confident_decision_opens_it(hub):
    hub["answer"] = (f"entity:{TASK}", 0.97, "show")
    r = await navigator.route("open the zoom oauth task", here={"view": "home", "address": "/dock/home"})
    assert (r.route, r.target.kind, r.target.value, r.reason) == ("quick", "entity", TASK, "decision")
    spec = hub["specs"][0]
    assert spec.state["utterance"] == "open the zoom oauth task" and spec.state["candidates"][0]["typeid"] == TASK
    assert spec.state["page"] == "/dock/home"
    assert "agentic" in spec.questions["target"].options and f"entity:{TASK}" in spec.questions["target"].options


@pytest.mark.parametrize(
    ("answer", "error", "reason"),
    [
        ((f"entity:{TASK}", 0.84, "show"), None, "unsure"),  # just under the bar: not trusted
        (("agentic", 0.99, "show"), None, "agentic"),
        (None, DecisionError("rate_limited", "slow down"), "rate_limited"),
        (None, DecisionError("unavailable", "hub down"), "unavailable"),
    ],
)
async def test_anything_short_of_a_confident_open_goes_to_the_assistant(hub, answer, error, reason):
    hub["answer"], hub["error"] = answer, error
    r = await navigator.route("summarize the zoom oauth task")
    assert (r.route, r.target, r.reason) == ("agentic", None, reason)


def test_every_screen_offered_is_a_real_address_and_none_is_offered_twice():
    options, _ = navigator.static_options()
    for key in options:
        if key.startswith("view:"):
            assert parse_dock_url("/dock/" + key[len("view:") :]) is not None, key
    assert "view:assistant" not in options, "the assistant is where the request was typed"
    assert not {"view:triggers", "view:signals", "view:cron"} & set(options), "one Events screen, not four"


def test_an_entity_is_offered_once_unless_its_id_opens_a_different_screen():
    """``conversation/<id>`` beside the conversation entity is the same place twice; the two split
    the probability until neither clears the bar (measured 0.59 / 0.53)."""
    conv = "conversation-1e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b"
    opts = navigator.options_for(None, [{"typeid": conv, "type": "conversation", "title": "Dana"}])
    assert [k for k in opts if conv.split("-", 1)[1] in k] == [f"entity:{conv}"]
    proj = "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
    here = navigation.kind("navigation.here").model_validate({"project": {"typeid": proj}})
    opts = navigator.options_for(here, [])
    assert {f"entity:{proj}", f"view:graph/{proj.split('-', 1)[1]}"} <= set(opts)


def test_a_screen_an_entity_opens_is_offered_in_the_words_people_use():
    """Measured live: offered as bare "Lens", "open this session's transcript" fell under the bar
    (0.3); with the screen's aliases it opens."""
    proc = "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    here = navigation.kind("navigation.here").model_validate({"process": {"typeid": proc, "title": "refactor"}})
    lens = navigator.options_for(here, [])[f"view:lens/{proc.split('-', 1)[1]}"]
    assert "transcript" in lens and "'refactor'" in lens
